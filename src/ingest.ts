import {assertNotNull, def, last, wait} from '@subsquid/util-internal'
import assert from 'assert'
import type {Batch} from './batch/generic'
import {BatchRequest} from './batch/request'
import * as gw from './interfaces/gateway'
import {EvmBlock, EvmLog, EvmTransaction} from './interfaces/evm'
import {addErrorContext, withErrorContext} from './util/misc'
import {Range, rangeEnd} from './util/range'
import {DEFAULT_REQUEST as _DEFAULT_REQUEST} from './interfaces/dataSelection'
import {ArchiveClient, statusToHeight} from './archive'

export type Item =
    | {
          kind: 'evmLog'
          address: string
          evmLog: EvmLog
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
    archive: ArchiveClient
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
                    let response = await this.options.archive.query(ctx.archiveQuery)
                    let fetchEndTime = process.hrtime.bigint()

                    ctx.batchBlocksFetched = response.data.length

                    assert(response.status.dbMaxBlockNumber >= archiveHeight)
                    this.setArchiveHeight(statusToHeight(response.status))

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
                    let to: number
                    if (response.nextBlock < rangeEnd(batch.range)) {
                        to = response.nextBlock - 1
                        this.batches[0] = {
                            range: {from: to + 1, to: batch.range.to},
                            request: batch.request,
                        }
                    } else {
                        to = assertNotNull(batch.range.to)
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

        let args: gw.BatchRequest = {
            fromBlock: from,
            toBlock: to,
        }

        args.logs = req.getLogs().map((l) => ({
            address: l.address,
            topics: l.topics || [],
            fieldSelection: toGatewayFieldSelection({}, {block: {}, ...l.data}, CONTEXT_NESTING_SHAPE),
        }))

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
        let res = await this.options.archive.getHeight()
        this.setArchiveHeight(res)
        return this.archiveHeight
    }

    private setArchiveHeight(height: number): void {
        this.archiveHeight = Math.max(this.archiveHeight, height)
    }

    getLatestKnownArchiveHeight(): number {
        return this.archiveHeight
    }
}

const CONTEXT_NESTING_SHAPE = (() => {
    let transaction = {}
    let block = {}
    return {
        evmLog: {
            transaction,
        },
        transaction,
        block,
    }
})()

const REQUEST_TO_GATEWAY: Record<string, string> = {
    block: 'block',
    evmLog: 'log',
    transaction: 'transaction',
}

const DEFAULT_REQUEST: Record<string, any> = _DEFAULT_REQUEST

function toGatewayFieldSelection(
    startSelection: gw.FieldSelection,
    req: Record<string, any> | undefined,
    shape: Record<string, any>,
    subfield?: string
): gw.FieldSelection {
    let selection = startSelection as any
    if (subfield && selection[subfield] == null) selection[subfield] = {}
    for (let reqKey in req) {
        if (shape[reqKey]) {
            let selectKey = REQUEST_TO_GATEWAY[reqKey]
            assert(typeof req[reqKey] === 'object')
            if (selection[selectKey] == null) {
                toGatewayFieldSelection(selection, DEFAULT_REQUEST[reqKey], shape[reqKey], selectKey)
            }
            toGatewayFieldSelection(selection, req[reqKey], shape[reqKey], selectKey)
        } else {
            let o = subfield ? selection[subfield] : selection
            o[reqKey] = req[reqKey]
        }
    }
    return selection
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
        let log = go as any
        return {
            id: createId(block.block.number, block.block.hash, log.index),
            ...log,
        }
    })

    let transactions = createObjects<gw.Transaction, EvmTransaction>(block.transactions, (go) => {
        let {gas, gasPrice, ...transaction} = go as any
        let o = {
            id: createId(block.block.number, block.block.hash, transaction.index),
            ...transaction,
        }
        gas != null && (o.gas = BigInt(gas))
        gasPrice != null && (o.gasPrice = BigInt(gasPrice))
        return o
    })

    let items: Item[] = []

    for (let go of block.logs) {
        let evmLog = assertNotNull(logs.get(go.index)) as EvmLog
        evmLog.transaction = transactions.get(go.transactionIndex) as EvmTransaction
        items.push({
            kind: 'evmLog',
            address: evmLog.address,
            evmLog,
        })
    }

    for (let go of block.transactions) {
        let transaction = assertNotNull(transactions.get(go.index)) as EvmTransaction
        items.push({
            kind: 'transaction',
            address: transaction.from,
            transaction,
        })
    }

    items.sort((a, b) => {
        if (a.kind === 'evmLog' && b.kind === 'evmLog') {
            return Number(a.evmLog.transactionIndex + a.evmLog.index - b.evmLog.transactionIndex - b.evmLog.index)
        } else if (a.kind === 'transaction' && b.kind === 'transaction') {
            return Number(a.transaction.index - b.transaction.index)
        } else {
            return Number(
                a.kind === 'evmLog' && b.kind === 'transaction'
                    ? a.evmLog.transactionIndex - b.transaction.index
                    : a.kind === 'transaction' && b.kind === 'evmLog'
                    ? a.transaction.index - b.evmLog.transactionIndex
                    : 0
            )
        }
    })

    let {timestamp, number: height, nonce, size, gasLimit, gasUsed, ...hdr} = block.block

    return {
        header: {
            id: `${height}-${block.block.hash.slice(3, 7)}`,
            height,
            timestamp: timestamp * 1000,
            nonce: BigInt(nonce),
            size: BigInt(size),
            gasLimit: BigInt(gasLimit),
            gasUsed: BigInt(gasUsed),
            ...hdr,
        },
        items: items,
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

type PartialObj<T> = Partial<T> & {index: bigint}
