import {EvmTopicSet} from '../interfaces/dataHandlers'
import {LogDataRequest, TransactionDataRequest} from '../interfaces/dataSelection'

type LogReq = {
    address: string[] | null
    topics?: EvmTopicSet
    data?: LogDataRequest
}

type TransactionReq = {
    address: string[] | null
    sighash?: string
    data?: TransactionDataRequest
}

export interface BatchRequest {
    getLogs(): LogReq[]
    getTransactions(): TransactionReq[]
}

export class PlainBatchRequest implements BatchRequest {
    logs: LogReq[] = []
    transactions: TransactionReq[] = []

    getLogs() {
        return this.logs
    }

    getTransactions() {
        return this.transactions
    }

    merge(other: PlainBatchRequest): PlainBatchRequest {
        let result = new PlainBatchRequest()
        result.logs = this.logs.concat(other.logs)
        return result
    }
}
