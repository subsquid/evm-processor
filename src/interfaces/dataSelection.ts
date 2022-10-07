import type {EvmLog, EvmTransaction} from './evm'

type Req<T> = {
    [P in keyof T]?: unknown
}

type PlainReq<T> = {
    [P in keyof T]?: true
}

type Select<T, R extends Req<T>> = {
    [P in keyof T as R[P] extends true ? P : P extends 'id' ? P : never]: T[P]
}

export type WithProp<K extends string, V> = [V] extends [never]
    ? {}
    : {
          [k in K]: V
      }

type LogScalars<T = EvmLog> = Omit<T, 'transaction'>

export type TransactionRequest = Omit<PlainReq<EvmTransaction>, keyof TransactionDefaultRequest>

export type LogRequest = Omit<PlainReq<LogScalars>, keyof LogDefaultRequest>

type TransactionFields<R extends TransactionRequest> = Select<EvmTransaction, R & TransactionDefaultRequest>

export type TransactionType<R, A = string> = (R extends true
    ? EvmTransaction
    : R extends TransactionRequest
    ? TransactionFields<R>
    : never) & {to: A}

// type ApplyTransactionFields<R extends LogRequest> = R['transaction'] extends true
//     ? {transaction: EvmTransaction}
//     : R['transaction'] extends TransactionRequest
//     ? {transaction: TransactionFields<R['transaction']>}
//     : {}

type LogFields<R extends LogRequest> = Select<LogScalars, R & LogDefaultRequest> //& ApplyTransactionFields<R>

type LogType<R, A = string> = (R extends LogRequest ? LogFields<R> : LogFields<{}>) & {address: A}

export interface TransactionDataRequest {
    transaction?: TransactionRequest
}

export type TransactionData<R extends TransactionDataRequest = {transaction: {}}, A = string> = WithProp<
    'transaction',
    TransactionType<R['transaction'], A>
>

export interface LogDataRequest extends TransactionDataRequest {
    evmLog?: LogRequest
}

export type LogData<R extends LogDataRequest = {evmLog: {}}, A = string> = WithProp<'evmLog', LogType<R['evmLog'], A>> &
    WithProp<'transaction', TransactionType<R['transaction'], A>>

type SetAddress<T, A> = Omit<T, 'address'> & {address: A}
type SetItemAddress<T, P, A> = P extends keyof T ? Omit<T, P> & {[p in P]: SetAddress<T[P], A>} & {address: A} : never

type WithKind<K, T> = {kind: K} & {
    [P in keyof T]: T[P]
}

export type LogItem<Address, R extends LogDataRequest = {}> = WithKind<
    'evmLog',
    SetItemAddress<LogData<R, Address>, 'evmLog', Address>
>

export type TransactionItem<Address, R extends TransactionDataRequest = {}> = WithKind<
    'transaction',
    SetItemAddress<TransactionData<R, Address>, 'transaction', Address>
>

export type ItemMerge<A, B, R> = [A] extends [never]
    ? B
    : [B] extends [never]
    ? A
    : undefined extends A
    ? undefined | ObjectItemMerge<Exclude<A, undefined>, Exclude<B, undefined>, Exclude<R, undefined | boolean>>
    : ObjectItemMerge<A, B, Exclude<R, undefined | boolean>>

type ObjectItemMerge<A, B, R> = {
    [K in keyof A | keyof B]: K extends keyof A
        ? K extends keyof B
            ? K extends keyof R
                ? ItemMerge<A[K], B[K], R[K]>
                : A[K]
            : A[K]
        : K extends keyof B
        ? B[K]
        : never
}

type ItemKind = {
    kind: string
    address: string
}

type AddItem<T extends ItemKind, I extends ItemKind, R> =
    | (T extends Pick<I, 'kind' | 'address'> ? ItemMerge<T, I, R> : T)
    | Exclude<I, Pick<T, 'kind' | 'address'>>

export type AddLogItem<T extends ItemKind, I extends ItemKind> = AddItem<T, I, LogDataRequest>
export type AddTransactionItem<T extends ItemKind, I extends ItemKind> = AddItem<T, I, TransactionDataRequest>

export interface DataSelection<R> {
    data: R
}

export interface NoDataSelection {
    data?: undefined
}

export interface MayBeDataSelection<R> {
    data?: R
}

export const DEFAULT_REQUEST = {
    block: {
        id: true,
        number: true,
        hash: true,
        parentHash: true,
        nonce: true,
        sha3Uncles: true,
        logsBloom: true,
        transactionsRoot: true,
        stateRoot: true,
        receiptsRoot: true,
        miner: true,
        difficulty: true,
        totalDifficulty: true,
        extraData: true,
        size: true,
        gasLimit: true,
        gasUsed: true,
        timestamp: true,
    },
    evmLog: {
        id: true,
        address: true,
        index: true,
        transactionIndex: true,
    },
    transaction: {
        id: true,
        to: true,
        index: true,
    },
} as const

type LogDefaultRequest = typeof DEFAULT_REQUEST.evmLog
type TransactionDefaultRequest = typeof DEFAULT_REQUEST.transaction
