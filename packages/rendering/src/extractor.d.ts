export interface ExtractedArticle {
    title: string;
    byline?: string;
    excerpt?: string;
    contentHtml: string;
    textContent: string;
    length: number;
}
export declare class ContentExtractor {
    private minTextLength;
    constructor(minTextLength?: number);
    extract(rawHtml: string, pageUrl: string): ExtractedArticle;
    private extractSemanticFallback;
    private extractFallbackTitle;
}
//# sourceMappingURL=extractor.d.ts.map