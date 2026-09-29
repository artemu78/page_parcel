import { JobStore } from '@readable-web/jobs';
import { PdfFormat, PdfFormattingParams } from '@readable-web/pdf';
import { VkApiClient } from '@readable-web/vk';
import { Logger } from '@readable-web/observability';
export interface JobProcessorOptions {
    jobStore: JobStore;
    vkClient?: VkApiClient;
    workerId?: string;
    logger?: Logger;
    leaseDurationMs?: number;
    pdfFormatting?: PdfFormattingParams | PdfFormat;
}
export declare class JobProcessor {
    private jobStore;
    private vkClient?;
    private workerId;
    private logger;
    private leaseDurationMs;
    private browserManager;
    private pdfGenerator;
    private defaultPdfFormatting?;
    constructor(options: JobProcessorOptions);
    processJob(jobId: string): Promise<{
        success: boolean;
        retryable: boolean;
    }>;
    private classifyError;
    private sendFailureNotification;
    private notifyErrorListeners;
    private formatArticleForLog;
    close(): Promise<void>;
}
//# sourceMappingURL=job-processor.d.ts.map