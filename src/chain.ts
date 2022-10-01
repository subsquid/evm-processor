import {ResilientRpcClient} from '@subsquid/rpc-client/lib/resilient'

export interface ChainManagerOptions {
    getChainClient: () => ResilientRpcClient
}

export class Chain {
    constructor(private getClient: () => ResilientRpcClient) {}

    get client(): ResilientRpcClient {
        return this.getClient()
    }
}
