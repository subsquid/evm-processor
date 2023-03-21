import {EvmTopicSet} from '../interfaces/dataHandlers'
import {LogDataRequest, TransactionDataRequest} from '../interfaces/dataSelection'

type LogReq = {
    address: string[]
    topics?: EvmTopicSet
    data?: LogDataRequest
}

type TransactionReq = {
    to: string[]
    from?: string[]
    sighash?: string[]
    data?: TransactionDataRequest
}

export interface BatchRequest {
    getLogs(): LogReq[]
    getTransactions(): TransactionReq[]
    getIncludeAllBlocks(): boolean
}

export class PlainBatchRequest implements BatchRequest {
    logs: LogReq[] = []
    transactions: TransactionReq[] = []
    includeAllBlocks = false

    getLogs() {
        return this.logs
    }

    getTransactions() {
        return this.transactions
    }

    getIncludeAllBlocks(): boolean {
        return this.includeAllBlocks
    }

    merge(other: PlainBatchRequest): PlainBatchRequest {
        let result = new PlainBatchRequest()
        result.logs = this.logs.concat(other.logs)
        result.transactions = this.transactions.concat(other.transactions)
        result.includeAllBlocks = this.includeAllBlocks || other.includeAllBlocks
        return result
    }
}
