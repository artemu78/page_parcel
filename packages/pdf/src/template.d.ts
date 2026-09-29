export type PdfFormat = 'mobile' | 'desktop' | 'a4' | 'a5';
export interface PdfMarginOptions {
    top?: string;
    bottom?: string;
    left?: string;
    right?: string;
}
export interface PdfFormattingParams {
    format?: PdfFormat;
    pageWidth?: string;
    pageHeight?: string;
    pageFormat?: string;
    margin?: PdfMarginOptions;
    fontSizePt?: number;
    titleFontSizePt?: number;
    h1FontSizePt?: number;
    h2FontSizePt?: number;
    h3FontSizePt?: number;
    lineHeight?: number;
    textAlign?: 'left' | 'justify';
    viewport?: {
        width: number;
        height: number;
    };
    footerMarginRight?: string;
    footerFontSizePt?: number;
}
export interface ResolvedPdfFormatting {
    format: PdfFormat;
    pageWidth?: string;
    pageHeight?: string;
    pageFormat?: string;
    margin: {
        top: string;
        bottom: string;
        left: string;
        right: string;
    };
    fontSizePt: number;
    titleFontSizePt: number;
    h1FontSizePt: number;
    h2FontSizePt: number;
    h3FontSizePt: number;
    lineHeight: number;
    textAlign: 'left' | 'justify';
    viewport: {
        width: number;
        height: number;
    };
    footerMarginRight: string;
    footerFontSizePt: number;
}
export declare const MOBILE_FORMATTING: ResolvedPdfFormatting;
export declare const DESKTOP_FORMATTING: ResolvedPdfFormatting;
export declare const A5_FORMATTING: ResolvedPdfFormatting;
export declare function resolvePdfFormatting(params?: PdfFormattingParams | PdfFormat): ResolvedPdfFormatting;
export interface ReaderTemplateData {
    title: string;
    sourceHostname: string;
    originalUrl: string;
    finalUrl?: string;
    retrievedAt: Date;
    contentHtml: string;
    formatting?: PdfFormattingParams | PdfFormat;
}
export declare function escapeHtml(str: string): string;
export declare function buildReaderHtml(data: ReaderTemplateData, formatting?: PdfFormattingParams | PdfFormat): string;
//# sourceMappingURL=template.d.ts.map