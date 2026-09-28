import { JobStore } from './store.js';
import { QueueClient } from './queue.js';
import { Logger } from '@readable-web/observability';
export interface OutboxSweeperOptions {
    jobStore: JobStore;
    queueClient: QueueClient;
    logger?: Logger;
    staleAcceptedAgeMs?: number;
}
export declare class OutboxService {
    private jobStore;
    private queueClient;
    private logger;
    constructor(options: OutboxSweeperOptions);
    publishWithOutbox(jobId: string): Promise<void>;
}
//# sourceMappingURL=outbox.d.ts.map