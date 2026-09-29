export interface ExtractedArticle {
    title: string;
    byline?: string;
    excerpt?: string;
    contentHtml: string;
    textContent: string;
    length: number;
}
export interface ExtractionDiagnostics {
    rawHtmlLength: number;
    docTitle?: string;
    bodyTextLength: number;
    bodyTextSnippet?: string;
    failureReason: string;
    readabilityAttempted: boolean;
    readabilityReturned: boolean;
    readabilityTextLength?: number;
    semanticCandidatesFound: string[];
    finalUrl?: string;
    httpStatus?: number;
    totalRequests?: number;
}
export declare class ContentExtractionError extends Error {
    article: any;
    diagnostics?: ExtractionDiagnostics;
    constructor(message: string, article?: any, diagnostics?: ExtractionDiagnostics);
}
export declare class ContentExtractor {
    private minTextLength;
    constructor(minTextLength?: number);
    extract(rawHtml: string, pageUrl: string): ExtractedArticle;
    private extractSemanticFallback;
    private extractFallbackTitle;
}
//# sourceMappingURL=extractor.d.ts.map