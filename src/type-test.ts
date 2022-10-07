import {type} from 'os'
import {BatchHandlerContext} from './interfaces/dataHandlers'
import {EvmBatchProcessor} from './processor'

const db: any = {}

function getItem<I>(cb: (item: I) => void) {
    return async function (ctx: BatchHandlerContext<any, I>) {}
}

new EvmBatchProcessor().addLog('0xaa', {data: {evmLog: {topics: true}} as const}).run(
    db,
    getItem((item) => {
        if (item.address == '0xaa') {
            item.evmLog.topics
        }
    })
)

new EvmBatchProcessor()
    .addLog('0xaa', {data: {evmLog: {topics: true}} as const})
    .addLog('0xaa', {data: {evmLog: {data: true}} as const})
    .run(
        db,
        getItem((item) => {
            if (item.address == '0xaa') {
                item.evmLog.topics
                item.evmLog.data
            }
        })
    )

new EvmBatchProcessor().addLog('0xaa', {data: {}} as const).run(
    db,
    getItem((item) => {
        if (item.address == '0xaa') {
            item.evmLog.address
        }
    })
)

new EvmBatchProcessor()
    // .addLog([], {data: {evmLog: {data: true}}} as const)
    .addLog([], {data: {evmLog: {topics: true}}} as const)
    .addLog('0xaa', {data: {evmLog: {data: true}, transaction: {hash: true}} as const})
    .run(
        db,
        getItem((item) => {
            if (item.address === '0xaa') {
                item.transaction.hash
                item.evmLog.data
            } else {
                item.evmLog.topics
            }
        })
    )

