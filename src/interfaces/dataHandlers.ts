import {Logger} from '@subsquid/logger'
import {Chain} from '../chain'
import {Range} from '../util/range'
import {LogData, LogDataRequest, LogItem, LogRequest} from './dataSelection'
import {EvmBlock} from './evm'

export interface CommonHandlerContext<S> {
    /**
     * Not yet public description of chain metadata
     * @internal
     */
    _chain: Chain

    /**
     * A built-in logger to be used in mapping handlers. Supports trace, debug, warn, error, fatal
     * levels.
     */
    log: Logger

    store: S
    block: EvmBlock
}

type BlockLogsRequest = {
    [name in string]: {evmLog: LogRequest}
}

type BlockLogItem<R extends BlockLogsRequest> = ['*'] extends [keyof R]
    ? [keyof R] extends ['*']
        ? LogItem<string, R['*']>
        : {[A in keyof R]: LogItem<A, R[A]>}[keyof R]
    : {[A in keyof R]: LogItem<A, R[A]>}[keyof R] | LogItem<'*'>

interface BlockItemRequest {
    logs?: boolean | BlockLogsRequest
}

type BlockItem<R> = R extends true
    ? LogItem<true>
    : R extends BlockItemRequest
    ? LogItem<R['logs']>
    : BlockLogItem<{}>

export interface BlockHandlerDataRequest {
    includeAllBlocks?: boolean
    items?: boolean | BlockItemRequest
}

export type BlockHandlerContext<S, R extends BlockHandlerDataRequest = {}> = CommonHandlerContext<S> & {
    /**
     * A unified log of events and calls.
     *
     * All events deposited within a call are placed
     * before the call. All child calls are placed before the parent call.
     * List of block events is a subsequence of unified log.
     */
    items: BlockItem<R['items']>[]
}

export interface BlockHandler<S, R extends BlockHandlerDataRequest = {}> {
    (ctx: BlockHandlerContext<S, R>): Promise<void>
}

export type LogHandlerContext<S, R extends LogDataRequest = {evmLog: {}}> = CommonHandlerContext<S> & LogData<R>

export interface LogHandler<S, R extends LogDataRequest = {evmLog: {}}> {
    (ctx: LogHandlerContext<S, R>): Promise<void>
}

export interface BlockRangeOption {
    range?: Range
}

export interface LogOptions extends BlockRangeOption {
    /**
     * EVM topic filter as defined by https://docs.ethers.io/v5/concepts/events/#events--filters
     */
    filter?: EvmTopicSet
}

export type EvmTopicSet = string[][]
