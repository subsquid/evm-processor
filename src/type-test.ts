import {BatchContext, EvmBatchProcessor} from './processor'

const db: any = {}

function getItem<I>(cb: (item: I) => void) {
    return async function (ctx: BatchContext<any, I>) {}
}

new EvmBatchProcessor()
    .addLog('0xaadsfadfasdfasdfa', {data: {evmLog: {topics: true}} as const})
    .run(
        db,
        getItem((item) => {
            if (item.address == '0xaadsfadfasdfasdfa') {
                item.evmLog.topics
            }
        })
    )
