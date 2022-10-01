import {Logger, createLogger} from '@subsquid/logger'
import {ResilientRpcClient} from '@subsquid/rpc-client/lib/resilient'
import {runProgram, last, def, wait} from '@subsquid/util-internal'
import {ArchiveClient, Request} from './archive'
import {Batch, mergeBatches, applyRangeBound, getBlocksCount} from './batch/generic'
import {PlainBatchRequest, BatchRequest} from './batch/request'
import {Chain} from './chain'
import {BlockData, Ingest} from './ingest'
import {LogOptions} from './interfaces/dataHandlers'
import {
    LogItem,
    TransactionItem,
    NoDataSelection,
    AddLogItem,
    LogDataRequest,
    DataSelection,
    MayBeDataSelection,
} from './interfaces/dataSelection'
import {Database} from './interfaces/db'
import {EvmBlock} from './interfaces/evm'
import {Metrics} from './metrics'
import {withErrorContext, timeInterval} from './util/misc'
import {Range} from './util/range'

export interface DataSource {
    /**
     * Subsquid substrate archive endpoint URL
     */
    archive: string
    /**
     * Chain node RPC websocket URL
     */
    chain?: string
}

/**
 * A helper to get the resulting type of block item
 *
 * @example
 * const processor = new SubstrateBatchProcessor()
 *  .addEvent('Balances.Transfer')
 *  .addEvent('Balances.Deposit')
 *
 * type BlockItem = BatchProcessorItem<typeof processor>
 */
export type BatchProcessorItem<T> = T extends EvmBatchProcessor<infer I> ? I : never
export type BatchProcessorLogItem<T> = Extract<BatchProcessorItem<T>, {kind: 'event'}>
export type BatchProcessorTransactionItem<T> = Extract<BatchProcessorItem<T>, {kind: 'transaction'}>

export interface BatchContext<Store, Item> {
    /**
     * Not yet public description of chain metadata
     * @internal
     */
    _chain: Chain
    log: Logger
    store: Store
    blocks: BatchBlock<Item>[]
}

export interface BatchBlock<Item> {
    /**
     * Block header
     */
    header: EvmBlock
    /**
     * A unified log of events and calls.
     *
     * All events deposited within a call are placed
     * before the call. All child calls are placed before the parent call.
     * List of block events is a subsequence of unified log.
     */
    items: Item[]
}

/**
 * Provides methods to configure and launch data processing.
 *
 * Unlike {@link SubstrateProcessor}, `SubstrateBatchProcessor` can have
 * only one data handler, which accepts a list of blocks.
 *
 * This gives mapping developers an opportunity to reduce the number of round-trips
 * both to database and chain nodes,
 * thus providing much better performance.
 */
export class EvmBatchProcessor<Item extends {kind: string; address: string} = LogItem<'*'> | TransactionItem<'*'>> {
    private batches: Batch<PlainBatchRequest>[] = []
    private options: any = {}
    private src?: DataSource
    private running = false
    private metrics = new Metrics()
    private _lastBlock = -1

    private add(request: PlainBatchRequest, range?: Range): void {
        this.batches.push({
            range: range || {from: 0},
            request,
        })
    }

    addLog<A extends string | ReadonlyArray<string>>(
        contractAddress: A,
        options?: LogOptions & NoDataSelection
    ): EvmBatchProcessor<AddLogItem<Item, LogItem<NormalizeAddress<A>, {}>>>

    addLog<A extends string | ReadonlyArray<string>, R extends LogDataRequest>(
        contractAddress: A,
        options: LogOptions & DataSelection<R>
    ): EvmBatchProcessor<AddLogItem<Item, LogItem<NormalizeAddress<A>, R>>>

    addLog(
        contractAddress: string | string[],
        options?: LogOptions & MayBeDataSelection<LogDataRequest>
    ): EvmBatchProcessor<any> {
        this.assertNotRunning()
        let req = new PlainBatchRequest()
        req.logs.push({
            address: Array.isArray(contractAddress) ? contractAddress : [contractAddress],
            topics: options?.filter,
            data: options?.data,
        })
        this.add(req, options?.range)
        return this
    }

    /**
     * Sets the port for a built-in prometheus metrics server.
     *
     * By default, the value of `PROMETHEUS_PORT` environment
     * variable is used. When it is not set,
     * the processor will pick up an ephemeral port.
     */
    setPrometheusPort(port: number | string): this {
        this.assertNotRunning()
        this.options.prometheusPort = port
        return this
    }

    /**
     * Limits the range of blocks to be processed.
     *
     * When the upper bound is specified,
     * the processor will terminate with exit code 0 once it reaches it.
     */
    setBlockRange(range?: Range): this {
        this.assertNotRunning()
        this.options.blockRange = range
        return this
    }

    setBatchSize(size: number): this {
        this.assertNotRunning()
        this.options.batchSize = size
        return this
    }

    /**
     * Sets blockchain data source.
     *
     * @example
     * processor.setDataSource({
     *     chain: 'wss://rpc.polkadot.io',
     *     archive: 'https://eth.archive.subsquid.io'
     * })
     */
    setDataSource(src: DataSource): this {
        this.assertNotRunning()
        this.src = src
        return this
    }

    private assertNotRunning(): void {
        if (this.running) {
            throw new Error('Settings modifications are not allowed after start of processing')
        }
    }

    private getArchiveEndpoint(): string {
        let url = this.src?.archive
        if (url == null) {
            throw new Error('use .setDataSource() to specify archive url')
        }
        return url
    }

    private getChainEndpoint(): string {
        let url = this.src?.chain
        if (url == null) {
            throw new Error(`use .setDataSource() to specify chain RPC endpoint`)
        }
        return url
    }

    @def
    private getLogger(): Logger {
        return createLogger('sqd:processor')
    }

    /**
     * Run data processing.
     *
     * This method assumes full control over the current OS process as
     * it terminates the entire program in case of error or
     * at the end of data processing.
     *
     * @param db - database is responsible for providing storage to data handlers
     * and persisting mapping progress and status.
     *
     * @param handler - The data handler, see {@link BatchContext} for an API available to the handler.
     */
    run<Store>(db: Database<Store>, handler: (ctx: BatchContext<Store, Item>) => Promise<void>): void {
        this.running = true
        runProgram(
            async () => {
                let log = this.getLogger()

                let heightAtStart = await db.connect()
                if (heightAtStart >= 0) {
                    log.info(`last processed block was ${heightAtStart}`)
                }

                let blockRange = this.getWholeBlockRange()
                if (blockRange.to != null && blockRange.to < heightAtStart + 1) {
                    log.info(`processing range is [${blockRange.from}, ${blockRange.to}]`)
                    log.info('nothing to do')
                    return
                } else {
                    blockRange = {
                        from: Math.max(heightAtStart + 1, blockRange.from),
                        to: blockRange.to,
                    }
                }

                log.info(
                    `processing blocks from ${blockRange.from}${blockRange.to == null ? '' : ' to ' + blockRange.to}`
                )

                let ingest = new Ingest({
                    archive: this.archiveClient(),
                    batches: this.createBatches(blockRange),
                })

                this.metrics.updateProgress(
                    await ingest.fetchArchiveHeight(),
                    getBlocksCount(this.wholeRange(), 0, ingest.getLatestKnownArchiveHeight()),
                    getBlocksCount(this.wholeRange(), heightAtStart + 1, ingest.getLatestKnownArchiveHeight())
                )

                let prometheusServer = await this.metrics.serve(this.getPrometheusPort())
                log.info(`prometheus metrics are served at port ${prometheusServer.port}`)

                return this.process(db, ingest, handler)
            },
            (err) => this.getLogger().fatal(err)
        )
    }

    @def
    protected archiveClient(): ArchiveClient {
        let url = this.getArchiveEndpoint()
        let log = this.getLogger().child('archive', {url})
        let counter = 0
        let metrics = this.metrics
        let id = this.getId()

        class ProcessorArchiveClient extends ArchiveClient {
            constructor(){
                super({
                    url,
                    id,
                    onRetry(err, query, errorsInRow, backoff) {
                        metrics.registerArchiveRetry(url, errorsInRow)
                        log.warn(
                            {
                                archiveUrl: url,
                                archiveRequestId: counter,
                                archiveQuery: query,
                                backoff,
                                reason: err.message,
                            },
                            'retry'
                        )
                    }
                })
            }

            protected async request<T>(req: Request): Promise<T> {
                log.debug(
                    {
                        archiveUrl: url,
                        archiveRequestId: counter,
                        archiveQuery: req.query,
                    },
                    'request'
                )
                let result: T = await super.request(req)
                metrics.registerArchiveResponse(url)
                log.debug(
                    {
                        archiveUrl: url,
                        archiveRequestId: counter,
                        archiveQuery: req.query,
                        archiveResponse: log.isTrace() ? result : undefined,
                    },
                    'response'
                )
                return result
            }
        }

        return new ProcessorArchiveClient()
    }

    @def
    protected chainClient(): ResilientRpcClient {
        let url = this.getChainEndpoint()
        let log = this.getLogger().child('chain-rpc', {url})
        let metrics = this.metrics
        let counter = 0

        class ChainClient extends ResilientRpcClient {
            constructor() {
                super({
                    url,
                    onRetry(err, errorsInRow, backoff) {
                        metrics.registerChainRpcRetry(url, errorsInRow)
                        log.warn(
                            {
                                backoff,
                                reason: err.message,
                            },
                            'connection error'
                        )
                    },
                })
            }

            async call<T = any>(method: string, params?: unknown[]): Promise<T> {
                let id = counter
                counter = (counter + 1) % 10000
                log.debug(
                    {
                        req: id,
                        method,
                        params,
                    },
                    'request'
                )
                let beg = process.hrtime.bigint()
                let result = await super.call(method, params).catch(
                    withErrorContext({
                        rpcUrl: url,
                        rpcRequestId: id,
                        rpcMethod: method,
                    })
                )
                let end = process.hrtime.bigint()
                let duration = end - beg
                metrics.registerChainRpcResponse(url, method, beg, end)
                log.debug(
                    {
                        req: id,
                        responseTime: Math.round(Number(duration) / 1000_000),
                    },
                    'response'
                )
                return result
            }
        }

        return new ChainClient()
    }

    @def
    protected getChain(): Chain {
        return new Chain(() => this.chainClient())
    }

    protected getWholeBlockRange(): Range {
        return this.options.blockRange || {from: 0}
    }

    @def
    protected wholeRange(): {range: Range}[] {
        return this.createBatches(this.getWholeBlockRange())
    }

    protected get lastBlock(): number {
        return this._lastBlock
    }

    protected set lastBlock(height: number) {
        this._lastBlock = height
        this.metrics.setLastProcessedBlock(height)
    }

    private async process(
        db: Database<any>,
        ingest: Ingest<BatchRequest>,
        handler: (ctx: BatchContext<any, Item>) => Promise<void>
    ): Promise<void> {
        for await (let batch of ingest.getBlocks()) {
            let log = this.getLogger()
            let mappingStartTime = process.hrtime.bigint()
            let blocks = batch.blocks
            
            if (batch.blocks.length != 0) {
                let from = Number(blocks[0].header.height)
                let to = Number(last(blocks).header.height)
                await db.transact(from, to, (store) => {
                    return handler({
                        _chain: this.getChain(),
                        log,
                        store,
                        blocks: blocks as any,
                    })
                })
            }

            this.lastBlock = batch.range.to
            await db.advance(this.lastBlock)

            let mappingEndTime = process.hrtime.bigint()

            this.metrics.updateProgress(
                ingest.getLatestKnownArchiveHeight(),
                getBlocksCount(this.wholeRange(), 0, ingest.getLatestKnownArchiveHeight()),
                getBlocksCount(this.wholeRange(), this.lastBlock + 1, ingest.getLatestKnownArchiveHeight()),
                mappingEndTime
            )

            this.metrics.registerBatch(
                batch.blocks.length,
                getItemsCount(batch.blocks),
                batch.fetchStartTime,
                batch.fetchEndTime,
                mappingStartTime,
                mappingEndTime
            )

            log.info(
                `${this.lastBlock} / ${this.metrics.getChainHeight()}, ` +
                    `rate: ${Math.round(this.metrics.getSyncSpeed())} blocks/sec, ` +
                    `mapping: ${Math.round(this.metrics.getMappingSpeed())} blocks/sec, ` +
                    `${Math.round(this.metrics.getMappingItemSpeed())} items/sec, ` +
                    `ingest: ${Math.round(this.metrics.getIngestSpeed())} blocks/sec, ` +
                    `eta: ${timeInterval(this.metrics.getSyncEtaSeconds())}`
            )
        }
    }

    private createBatches(blockRange: Range) {
        let batches = mergeBatches(this.batches, (a, b) => a.merge(b))
        return applyRangeBound(batches, blockRange)
    }

    private getPrometheusPort(): number | string {
        let port = this.options.prometheusPort
        return port == null ? process.env.PROCESSOR_PROMETHEUS_PORT || process.env.PROMETHEUS_PORT || 0 : port
    }

    @def
    private getId() {
        return process.env.SQUID_ID || `gen-${randomString(10)}`
    }
}

function getItemsCount(blocks: BlockData[]): number {
    let count = 0
    for (let i = 0; i < blocks.length; i++) {
        count += blocks[i].items.length
    }
    return count
}

function randomString(len: number) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

    let result = ''
    for (let i = 0; i < len; i++) {
        result += chars[Math.floor(Math.random() * chars.length)]
    }

    return result
}

type NormalizeAddress<T extends string | ReadonlyArray<string>> = Lowercase<T extends ReadonlyArray<infer R> ? R : T>