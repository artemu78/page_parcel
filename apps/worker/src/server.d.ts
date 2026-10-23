import { Logger } from '@readable-web/observability';
import { JobProcessor } from './job-processor.js';
import { AiQueueMessage } from '@readable-web/jobs';
export interface WorkerServerOptions {
    port?: number;
    processAiRequest?: (message: AiQueueMessage) => Promise<{
        retryable: boolean;
    }>;
    processor: JobProcessor;
    logger?: Logger;
    triggerSecret?: string;
}
export declare class WorkerServer {
    private server;
    private port;
    private processAiRequest?;
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