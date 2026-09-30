import * as crypto from 'node:crypto';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { Logger, defaultLogger, metrics } from '@readable-web/observability';
import {
  buildReaderHtml,
  ReaderTemplateData,
  PdfFormattingParams,
  PdfFormat,
  resolvePdfFormatting
} from './template.js';

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

export class PdfGenerator {
  private browser: Browser | null = null;
  private logger: Logger;
  private maxPdfBytes: number;
  private defaultFormatting?: PdfFormattingParams | PdfFormat;

  constructor(
    logger?: Logger,
    maxPdfBytes = 10 * 1024 * 1024,
    defaultFormatting?: PdfFormattingParams | PdfFormat
  ) {
    this.logger = (logger ?? defaultLogger).child({ component: 'PdfGenerator' });
    this.maxPdfBytes = maxPdfBytes;
    this.defaultFormatting = defaultFormatting;
  }

  public async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.logger.info('Launching Chromium browser instance for PDF generator');
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          ...(process.platform === 'linux' ? ['--single-process'] : []),
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
    const formatting = resolvePdfFormatting(
      options.formatting ?? options.data.formatting ?? this.defaultFormatting
    );
    const htmlContent = buildReaderHtml(options.data, formatting);

    // Completely isolated offline context with JavaScript and networking disabled
    const context: BrowserContext = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      viewport: formatting.viewport
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

      const pdfOptions: Parameters<Page['pdf']>[0] = {
        printBackground: true,
        margin: formatting.margin,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: `
          <div style="font-size: ${formatting.footerFontSizePt}pt; font-family: sans-serif; text-align: right; width: 100%; margin-right: ${formatting.footerMarginRight}; color: #94a3b8;">
            Readable Web • <span class="pageNumber"></span> / <span class="totalPages"></span>
          </div>
        `
      };

      if (formatting.pageWidth && formatting.pageHeight) {
        pdfOptions.width = formatting.pageWidth;
        pdfOptions.height = formatting.pageHeight;
      } else if (formatting.pageFormat) {
        pdfOptions.format = formatting.pageFormat as any;
      }

      const pdfBuffer = await page.pdf(pdfOptions);

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
        await page.close().catch(err => { this.logger.exception(err, 'Close PDF browser resources'); });
      }
      await context.close().catch(err => { this.logger.exception(err, 'Close PDF browser resources'); });
    }
  }

  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(err => { this.logger.exception(err, 'Close PDF browser resources'); });
      this.browser = null;
    }
  }
}
