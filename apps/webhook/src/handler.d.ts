import { CallbackValidationOptions, VkApiClient } from '@readable-web/vk';
import { JobStore, OutboxService } from '@readable-web/jobs';
import { Logger } from '@readable-web/observability';
import { OpenRouterClient } from './openrouter.js';
export interface WebhookHandlerOptions {
    jobStore: JobStore;
    outboxService: OutboxService;
    vkClient?: VkApiClient;
    openRouterClient?: OpenRouterClient;
    validationOptions: CallbackValidationOptions;
    logger?: Logger;
    maxUserRequestsPerMinute?: number;
}
export declare class WebhookHandler {
    private jobStore;
    private outboxService;
    private vkClient?;
    private openRouterClient?;
    private validationOptions;
    private logger;
    private maxRequestsPerMinute;
    constructor(options: WebhookHandlerOptions);
    handleRequest(body: unknown): Promise<{
        statusCode: number;
        body: string;
    }>;
    private processMessageEvent;
    private handleRole3ChatMessage;
    private handleReadCommand;
    private handleStatusCommand;
    private sendReply;
}
//# sourceMappingURL=handler.d.ts.map