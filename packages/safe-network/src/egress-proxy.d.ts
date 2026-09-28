import { SafeDnsResolver } from './dns-resolver.js';
import { Logger } from '@readable-web/observability';
export interface EgressProxyLimits {
    maxRequestsPerJob?: number;
    maxBytesPerResponse?: number;
    maxAggregateBytes?: number;
}
export interface EgressProxyOptions {
    port?: number;
    host?: string;
    dnsResolver?: SafeDnsResolver;
    logger?: Logger;
    limits?: EgressProxyLimits;
}
export declare class ValidatingEgressProxy {
    private server;
    private port;
    private host;
    private dnsResolver;
    private logger;
    private maxRequestsPerJob;
    private maxBytesPerResponse;
    private maxAggregateBytes;
    private totalRequests;
    private totalBytesTransferred;
    private activeSockets;
    constructor(options?: EgressProxyOptions);
    getPort(): number;
    getProxyUrl(): string;
    getStats(): {
        totalRequests: number;
        totalBytesTransferred: number;
        activeConnections: number;
    };
    start(): Promise<number>;
    stop(): Promise<void>;
    private incrementRequests;
    private trackBytes;
    private handleConnect;
    private handleHttpRequest;
}
//# sourceMappingURL=egress-proxy.d.ts.map