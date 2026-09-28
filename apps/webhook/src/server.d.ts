import { Logger } from '@readable-web/observability';
import { WebhookHandler } from './handler.js';
export interface WebhookServerOptions {
    port?: number;
    handler: WebhookHandler;
    logger?: Logger;
    maxBodyBytes?: number;
}
export declare class WebhookServer {
    private server;
    private port;
    private handler;
    private logger;
    private maxBodyBytes;
    constructor(options: WebhookServerOptions);
    getPort(): number;
    start(): Promise<number>;
    stop(): Promise<void>;
    private handleRequest;
}
//# sourceMappingURL=server.d.ts.map