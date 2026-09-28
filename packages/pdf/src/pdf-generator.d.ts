import { Browser } from 'playwright';
import { Logger } from '@readable-web/observability';
import { ReaderTemplateData } from './template.js';
export interface GeneratePdfOptions {
    data: ReaderTemplateData;
    jobId: string;
    maxBytes?: number;
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
    constructor(logger?: Logger, maxPdfBytes?: number);
    getBrowser(): Promise<Browser>;
    generateSafeFilename(jobId: string, title: string): string;
    generate(options: GeneratePdfOptions): Promise<GeneratedPdfResult>;
    close(): Promise<void>;
}
//# sourceMappingURL=pdf-generator.d.ts.map