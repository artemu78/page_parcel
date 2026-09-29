import { Browser } from 'playwright';
import { Logger } from '@readable-web/observability';
import { ReaderTemplateData, PdfFormattingParams, PdfFormat } from './template.js';
export interface GeneratePdfOptions {
    data: ReaderTemplateData;
    jobId: string;
    maxBytes?: number;
    formatting?: PdfFormattingParams | PdfFormat;
}
export interface GeneratedPdfResult {
    pdfBuffer: Buffer;
    filename: string;
    sizeBytes: number;
}
export declare class PdfGenerator {
    private browser;
    private logger;
    private maxPdfBytes;
    private defaultFormatting?;
    constructor(logger?: Logger, maxPdfBytes?: number, defaultFormatting?: PdfFormattingParams | PdfFormat);
    getBrowser(): Promise<Browser>;
    generateSafeFilename(jobId: string, title: string): string;
    generate(options: GeneratePdfOptions): Promise<GeneratedPdfResult>;
    close(): Promise<void>;
}
//# sourceMappingURL=pdf-generator.d.ts.map