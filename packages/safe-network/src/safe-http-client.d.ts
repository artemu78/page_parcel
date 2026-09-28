import * as http from 'node:http';
import { SafeDnsResolver } from './dns-resolver.js';
import { Logger } from '@readable-web/observability';
export interface SafeFetchOptions {
    maxRedirects?: number;
    maxBytes?: number;
    timeoutMs?: number;
    headers?: Record<string, string>;
    dnsResolver?: SafeDnsResolver;
    logger?: Logger;
}
export interface SafeFetchResponse {
    finalUrl: string;
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
    redirectsCount: number;
}
export declare function safeFetch(initialUrl: string, options?: SafeFetchOptions): Promise<SafeFetchResponse>;
//# sourceMappingURL=safe-http-client.d.ts.map