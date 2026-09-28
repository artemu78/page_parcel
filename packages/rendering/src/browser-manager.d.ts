import { Browser } from 'playwright';
import { Logger } from '@readable-web/observability';
import { ExtractedArticle } from './extractor.js';
export interface RenderJobOptions {
    url: string;
    egressProxyUrl: string;
    timeoutMs?: number;
    maxRequests?: number;
}
export interface RenderResult {
    article: ExtractedArticle;
    finalUrl: string;
    title: string;
    totalRequests: number;
}
export declare class BrowserManager {
    private browser;
    private logger;
    private extractor;
    constructor(logger?: Logger);
    getBrowser(): Promise<Browser>;
    renderAndExtract(options: RenderJobOptions): Promise<RenderResult>;
    close(): Promise<void>;
}
//# sourceMappingURL=browser-manager.d.ts.map