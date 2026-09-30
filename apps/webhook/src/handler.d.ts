import { SearchStore } from '@readable-web/jobs';
import { SearchClient } from './search.js';
import { CallbackValidationOptions, VkApiClient } from '@readable-web/vk';
import { JobStore, OutboxService } from '@readable-web/jobs';
import { Logger } from '@readable-web/observability';
import { OpenRouterClient } from './openrouter.js';
export interface WebhookHandlerOptions {
    searchStore?: SearchStore;
    searchClient?: SearchClient;
    jobStore: JobStore;
    outboxService: OutboxService;
    vkClient?: VkApiClient;
    openRouterClient?: OpenRouterClient;
    validationOptions: CallbackValidationOptions;
    logger?: Logger;
    maxUserRequestsPerMinute?: number;
}
export declare class WebhookHandler {
    private searchStore;
    private searchClient;
    private jobStore;
    private outboxService;
    private vkClient?;
    private validationOptions;
    private logger;
    private maxRequestsPerMinute;
    constructor(options: WebhookHandlerOptions);
    handleRequest(body: unknown): Promise<{
        statusCode: number;
        body: string;
    }>;
    private processMessageEvent;
    private greetAllowedUser;
    private handleSearch;
    private handleReadCommand;
    private handleStatusCommand;
    private sendReply;
}
//# sourceMappingURL=handler.d.ts.map