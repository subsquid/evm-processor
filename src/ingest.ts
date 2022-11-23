import {assertNotNull, def, last, wait} from '@subsquid/util-internal'
import assert from 'assert'
import type {Batch} from './batch/generic'
import {BatchRequest} from './batch/request'
import * as gw from './interfaces/gateway'
import {EvmBlock, EvmLog, EvmTransaction} from './interfaces/evm'
import {addErrorContext, withErrorContext} from './util/misc'
import {Range, rangeEnd} from './util/range'
import {DEFAULT_REQUEST} from './interfaces/dataSelection'
import {JSONClient} from './util/json'

export type Item =
    | {
          kind: 'evmLog'
          address: string
          evmLog: EvmLog
          transaction?: EvmTransaction
      }
    | {
          kind: 'transaction'
          address: string | undefined
          transaction: EvmTransaction
      }

export interface BlockData {
    header: EvmBlock
    items: Item[]
}

export interface DataBatch<R> {
    /**
     * This is roughly the range of scanned blocks
     */
    range: {from: number; to: number}
    request: R
    blocks: BlockData[]
    fetchStartTime: bigint
    fetchEndTime: bigint
}

export interface IngestOptions<R> {
    archive: JSONClient
    archivePollIntervalMS?: number
    batches: Batch<R>[]
}

export class Ingest<R extends BatchRequest> {
    private archiveHeight = -1
    private readonly batches: Batch<R>[]
    private readonly maxQueueSize = 3
    private queue: Promise<DataBatch<R>>[] = []
    private fetchLoopIsStopped = true

    constructor(private options: IngestOptions<R>) {
        this.batches = options.batches.slice()
    }

    @def
    async *getBlocks(): AsyncGenerator<DataBatch<R>> {
        while (this.batches.length) {
            if (this.fetchLoopIsStopped) {
                this.fetchLoop().catch()
            }
            yield await assertNotNull(this.queue[0])
            this.queue.shift()
        }
    }

    private async fetchLoop(): Promise<void> {
        assert(this.fetchLoopIsStopped)
        this.fetchLoopIsStopped = false
        while (this.batches.length && this.queue.length < this.maxQueueSize) {
            let batch = this.batches[0]
            let ctx: {
                batchRange: Range
                batchBlocksFetched?: number
                archiveHeight?: number
                archiveQuery?: string
            } = {
                batchRange: batch.range,
            }

            let promise = this.waitForHeight(batch.range.from)
                .then(async (archiveHeight) => {
                    ctx.archiveHeight = archiveHeight
                    ctx.archiveQuery = this.buildBatchQuery(batch, archiveHeight)

                    let fetchStartTime = process.hrtime.bigint()
                    let response: gw.QueryResponse = await this.options.archive.request({
                        path: '/query',
                        query: ctx.archiveQuery,
                        method: 'POST',
                    })
                    let fetchEndTime = process.hrtime.bigint()

                    ctx.batchBlocksFetched = response.data.length

                    assert(response.archiveHeight >= archiveHeight)
                    this.setArchiveHeight(archiveHeight)

                    let blocks = response.data
                        .flat()
                        .map(tryMapGatewayBlock)
                        .sort((a, b) => Number(a.header.height - b.header.height))
                    if (blocks.length) {
                        assert(batch.range.from <= blocks[0].header.height)
                        assert(rangeEnd(batch.range) >= last(blocks).header.height)
                        assert(archiveHeight >= last(blocks).header.height)
                    }

                    let from = batch.range.from
                    let to = response.nextBlock - 1
                    if (to < rangeEnd(batch.range)) {
                        this.batches[0] = {
                            range: {from: to + 1, to: batch.range.to},
                            request: batch.request,
                        }
                    } else {
                        this.batches.shift()
                    }

                    return {
                        blocks,
                        range: {from, to},
                        request: batch.request,
                        fetchStartTime,
                        fetchEndTime,
                    }
                })
                .catch(withErrorContext(ctx))

            this.queue.push(promise)

            let result = await promise.catch((err: unknown) => {
                assert(err instanceof Error)
                return err
            })

            if (result instanceof Error) {
                return
            }
        }
        this.fetchLoopIsStopped = true
    }

    private buildBatchQuery(batch: Batch<R>, archiveHeight: number): string {
        let from = batch.range.from
        let to = Math.min(archiveHeight, rangeEnd(batch.range))
        assert(from <= to)

        let req = batch.request

        let logs = req.getLogs().map((l) => ({
            address: l.address,
            topics: l.topics || [],
            fieldSelection: toGatewayFieldSelection(l.data),
        }))

        let transactions = req.getTransactions().map((t) => ({
            address: t.address,
            sighash: t.sighash,
            fieldSelection: toGatewayFieldSelection(t.data),
        }))

        let args: gw.BatchRequest = {
            fromBlock: from,
            toBlock: to,
            logs,
            transactions,
        }

        return JSON.stringify(args)
    }

    private async waitForHeight(minimumHeight: number): Promise<number> {
        while (this.archiveHeight < minimumHeight) {
            await this.fetchArchiveHeight()
            if (this.archiveHeight >= minimumHeight) {
                return this.archiveHeight
            } else {
                await wait(this.options.archivePollIntervalMS || 5000)
            }
        }
        return this.archiveHeight
    }

    async fetchArchiveHeight(): Promise<number> {
        let res: {height: number} = await this.options.archive.request({
            path: '/height',
            method: 'GET',
        })
        this.setArchiveHeight(res.height)
        return this.archiveHeight
    }

    private setArchiveHeight(height: number): void {
        this.archiveHeight = Math.max(this.archiveHeight, height)
    }

    getLatestKnownArchiveHeight(): number {
        return this.archiveHeight
    }
}

function toGatewayFieldSelection(req: any | undefined): gw.FieldSelection {
    return {
        block: DEFAULT_REQUEST.block,
        log: req?.evmLog
            ? {
                  ...req.evmLog,
                  ...DEFAULT_REQUEST.evmLog,
              }
            : undefined,
        transaction: req?.transaction
            ? {
                  ...req.transaction,
                  ...DEFAULT_REQUEST.transaction,
              }
            : undefined,
    }
}

function tryMapGatewayBlock(block: gw.BatchBlock): BlockData {
    try {
        return mapGatewayBlock(block)
    } catch (e: any) {
        throw addErrorContext(e, {
            blockHeight: block.block.number,
            blockHash: block.block.hash,
        })
    }
}

function mapGatewayBlock(block: gw.BatchBlock): BlockData {
    let logs = createObjects<gw.Log, EvmLog>(block.logs, (go) => {
        let log = go
        let evmLog: PartialObj<EvmLog> = {
            id: createId(block.block.number, block.block.hash, log.index),
            ...log,
        }
        return evmLog
    })

    let transactions = createObjects<gw.Transaction, EvmTransaction>(block.transactions, (go) => {
        let {gas, gasPrice, nonce, value, v, ...tx} = go
        let transaction: PartialObj<EvmTransaction> = {
            id: createId(block.block.number, block.block.hash, tx.index),
            ...tx,
        }
        if (gas != null) transaction.gas = BigInt(gas)
        if (gasPrice != null) transaction.gasPrice = BigInt(gasPrice)
        if (nonce != null) transaction.nonce = BigInt(nonce)
        if (value != null) transaction.value = BigInt(value)
        if (v != null) transaction.v = BigInt(v)
        return transaction
    })

    let items: Item[] = []

    for (let go of block.logs) {
        let evmLog = assertNotNull(logs.get(go.index)) as EvmLog
        let transaction = transactions.get(go.transactionIndex) as EvmTransaction
        items.push({
            kind: 'evmLog',
            address: evmLog.address,
            evmLog,
            transaction,
        })
    }

    for (let go of block.transactions) {
        let transaction = assertNotNull(transactions.get(go.index)) as EvmTransaction
        items.push({
            kind: 'transaction',
            address: transaction.to,
            transaction,
        })
    }

    items.sort((a, b) => {
        if (a.kind === 'evmLog' && b.kind === 'evmLog') {
            return a.evmLog.index - b.evmLog.index
        } else if (a.kind === 'transaction' && b.kind === 'transaction') {
            return a.transaction.index - b.transaction.index
        } else {
            if (a.kind === 'evmLog' && b.kind === 'transaction') {
                return a.evmLog.transactionIndex - b.transaction.index || -1
            } else if (a.kind === 'transaction' && b.kind === 'evmLog') {
                return a.transaction.index - b.evmLog.transactionIndex || 1
            } else {
                throw new Error('Unexpected case')
            }
        }
    })

    let {timestamp, number: height, nonce, size, gasLimit, gasUsed, ...hdr} = block.block

    return {
        header: {
            id: `${height}-${block.block.hash.slice(3, 7)}`,
            height,
            timestamp: Number(timestamp) * 1000,
            nonce: nonce !== undefined && nonce !== null ? BigInt(nonce) : nonce,
            size: BigInt(size),
            gasLimit: BigInt(gasLimit),
            gasUsed: BigInt(gasUsed),
            ...hdr,
        },
        items,
    }
}

function createObjects<S, T extends {index: number}>(src: S[], f: (s: S) => PartialObj<T>): Map<number, PartialObj<T>> {
    let m = new Map<number, PartialObj<T>>()
    for (let i = 0; i < src.length; i++) {
        let obj = f(src[i])
        m.set(obj.index, obj)
    }
    return m
}

function createId(height: number, hash: string, index?: number) {
    if (index == null) {
        return `${height}-${hash.slice(3, 11)}`
    } else {
        return `${height}-${index}-${hash.slice(3, 11)}`
    }
}

type PartialObj<T> = Partial<T> & {index: number}
