import assert from 'assert'
import fetch, {FetchError, RequestInit} from 'node-fetch'
import {isRetryableError, performFetch} from './fetch'
import {QueryResponse, StatusResponse} from '../interfaces/gateway'
import {URL} from 'url'

export interface JSONClientOptions {
    url: string
    onRetry?(err: Error, query: string | undefined, errorsInRow: number, backoff: number): void
}

export class JSONClient {
    constructor(private options: JSONClientOptions) {}

    // async query<T>(archiveQuery: string): Promise<QueryResponse> {
    //     return await this.request({
    //         url: this.options.url + '/query',
    //         query: archiveQuery,
    //         method: 'POST',
    //     })
    // }

    // async getStatus(): Promise<StatusResponse> {
    //     return await this.request({
    //         url: this.options.url + '/status',
    //         method: 'GET',
    //     })
    // }

    // async getHeight(): Promise<number> {
    //     return await this.getStatus().then(statusToHeight)
    // }

    async request<T>(req: Request): Promise<T> {
        let url = new URL(req.path, this.options.url).toString()
        let method = req.method || 'POST'
        let headers: Record<string, string> = {
            ...req.headers,
            accept: 'application/json',
            'accept-encoding': 'gzip, br',
        }
        let body: string | undefined

        if (method === 'POST') {
            headers['content-type'] = 'application/json; charset=UTF-8'
            body = req.query
        }

        let options = {method, headers, body, timeout: 60_000}

        let backoff = [100, 500, 2000, 5000, 10_000, 20_000]
        let errors = 0
        while (true) {
            let result = await performFetch(url, options).catch((err) => {
                assert(err instanceof Error)
                return err
            })
            if (isRetryableError(result)) {
                let timeout = backoff[Math.min(errors, backoff.length - 1)]
                errors += 1
                await wait(timeout).then(() => this.options.onRetry?.(result, body, errors, timeout))
            } else if (result instanceof Error) {
                throw result
            } else {
                return result
            }
        }
    }
}

export interface Request {
    headers?: Partial<Record<string, string>>
    path: string
    query?: string
    method?: 'GET' | 'POST'
}

export interface JSONError {
    message: string
    path?: (string | number)[]
}

export class ArchiveResponseError extends Error {
    constructor(public readonly errors: JSONError[]) {
        super(`Archive error: ${errors[0].message}`)
    }
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}
