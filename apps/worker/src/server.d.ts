import { Logger } from '@readable-web/observability';
import { JobProcessor } from './job-processor.js';
export interface WorkerServerOptions {
    port?: number;
    processor: JobProcessor;
    logger?: Logger;
    triggerSecret?: string;
}
export declare class WorkerServer {
    private server;
    private port;
    private processor;
    private logger;
    private triggerSecret?;
    constructor(options: WorkerServerOptions);
    getPort(): number;
    start(): Promise<number>;
    stop(): Promise<void>;
    private handleRequest;
}
//# sourceMappingURL=server.d.ts.map