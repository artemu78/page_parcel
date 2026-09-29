import { Logger } from '@readable-web/observability';
export interface OpenRouterClientOptions {
    apiKey: string;
    baseUrl?: string;
    defaultModel?: string;
    proxyUrl?: string;
    timeoutMs?: number;
    logger?: Logger;
}
export interface OpenRouterCompletionParams {
    prompt: string;
    model?: string;
    systemPrompt?: string;
    maxTokens?: number;
    baseUrl?: string;
    proxyUrl?: string;
}
export declare class OpenRouterClient {
    private apiKey;
    private baseUrl;
    private defaultModel;
    private proxyUrl?;
    private timeoutMs;
    private logger;
    constructor(options: OpenRouterClientOptions);
    complete(params: OpenRouterCompletionParams): Promise<string>;
}
/**
 * Splits a text into chunks not exceeding maxChunkLength characters (default 4000 for VK API 4096 character limit).
 */
export declare function splitMessage(text: string, maxChunkLength?: number): string[];
//# sourceMappingURL=openrouter.d.ts.map