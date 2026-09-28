import * as crypto from 'node:crypto';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { Logger, defaultLogger, metrics } from '@readable-web/observability';
import { buildReaderHtml, ReaderTemplateData } from './template.js';

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

export class PdfGenerator {
  private browser: Browser | null = null;
  private logger: Logger;
  private maxPdfBytes: number;

  constructor(logger?: Logger, maxPdfBytes = 10 * 1024 * 1024) {
    this.logger = (logger ?? defaultLogger).child({ component: 'PdfGenerator' });
    this.maxPdfBytes = maxPdfBytes;
  }

  public async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking'
        ]
      });
    }
    return this.browser;
  }

  public generateSafeFilename(jobId: string, title: string): string {
    const hash = crypto.createHash('sha256').update(`${jobId}-${title}`).digest('hex').slice(0, 10);
    // Sanitize title for filename preview (max 30 chars ASCII/alphanumeric, fallback to 'article')
    const safeTitlePart = title
      .toLowerCase()
      .replace(/[^a-z0-9а-яё]/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'article';

    return `${safeTitlePart}-${hash}.pdf`;
  }

  public async generate(options: GeneratePdfOptions): Promise<GeneratedPdfResult> {
    const browser = await this.getBrowser();
    const htmlContent = buildReaderHtml(options.data);

    // Completely isolated offline context with JavaScript and networking disabled
    const context: BrowserContext = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      viewport: { width: 1280, height: 800 }
    });

    let page: Page | null = null;

    try {
      page = await context.newPage();

      // Ensure no external requests can be made
      await page.route('**/*', (route) => {
        route.abort('blockedbyclient');
      });

      await page.setContent(htmlContent, {
        waitUntil: 'load',
        timeout: 15000
      });

      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: {
          top: '20mm',
          bottom: '20mm',
          left: '15mm',
          right: '15mm'
        },
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: `
          <div style="font-size: 8pt; font-family: sans-serif; text-align: right; width: 100%; margin-right: 15mm; color: #94a3b8;">
            Readable Web • <span class="pageNumber"></span> / <span class="totalPages"></span>
          </div>
        `
      });

      const sizeBytes = pdfBuffer.length;
      metrics.pdfSizeBytes.observe(sizeBytes);

      if (sizeBytes > (options.maxBytes ?? this.maxPdfBytes)) {
        metrics.failedJobsTotal.inc({ category: 'SIZE_EXCEEDED' });
        throw new Error(
          `Generated PDF size (${sizeBytes} bytes) exceeds limit of ${options.maxBytes ?? this.maxPdfBytes} bytes`
        );
      }

      const filename = this.generateSafeFilename(options.jobId, options.data.title);

      return {
        pdfBuffer,
        filename,
        sizeBytes
      };
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
      await context.close().catch(() => {});
    }
  }

  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
