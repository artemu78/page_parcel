export interface ReaderTemplateData {
    title: string;
    sourceHostname: string;
    originalUrl: string;
    finalUrl?: string;
    retrievedAt: Date;
    contentHtml: string;
}
export declare function escapeHtml(str: string): string;
export declare function buildReaderHtml(data: ReaderTemplateData): string;
//# sourceMappingURL=template.d.ts.map