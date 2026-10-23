import { Job, JobQueueMessage } from './types.js';
import { Logger } from '@readable-web/observability';
export interface AiQueueMessage {
    kind: 'ai';
    ownerId: number;
    eventId: string;
}
export interface QueueClient {
    publishAiRequest?(message: AiQueueMessage): Promise<void>;
    publishJob(job: Job): Promise<void>;
}
export interface SqsQueueOptions {
    queueUrl: string;
    region?: string;
    endpoint?: string;
    credentials?: {
        accessKeyId: string;
        secretAccessKey: string;
    };
    logger?: Logger;
}
export declare class SqsQueueClient implements QueueClient {
    private client;
    private queueUrl;
    private logger;
    constructor(options: SqsQueueOptions);
    publishAiRequest(message: AiQueueMessage): Promise<void>;
    publishJob(job: Job): Promise<void>;
}
export declare class MemoryQueueClient implements QueueClient {
    messages: JobQueueMessage[];
    aiMessages: AiQueueMessage[];
    publishAiRequest(message: AiQueueMessage): Promise<void>;
    publishJob(job: Job): Promise<void>;
}
//# sourceMappingURL=queue.d.ts.map