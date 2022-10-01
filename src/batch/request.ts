import {EvmTopicSet} from '../interfaces/dataHandlers'
import {LogDataRequest, LogRequest, TransactionDataRequest} from '../interfaces/dataSelection'

type LogReq = {
    address: string[] | null
    topics?: EvmTopicSet
    data?: LogDataRequest
}

export interface BatchRequest {
    getLogs(): LogReq[]
}

export class PlainBatchRequest implements BatchRequest {
    logs: LogReq[] = []
    logsRequest?: LogDataRequest
    transactionsRequest?: TransactionDataRequest

    getLogs() {
        return this.logs
    }

    merge(other: PlainBatchRequest): PlainBatchRequest {
        let result = new PlainBatchRequest()
        result.logs = this.logs.concat(other.logs)
        return result
    }
}
