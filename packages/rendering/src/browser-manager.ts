import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { Logger, defaultLogger } from '@readable-web/observability';
import { ContentExtractor, ExtractedArticle } from './extractor.js';

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

export class BrowserManager {
  private browser: Browser | null = null;
  private logger: Logger;
  private extractor: ContentExtractor;

  constructor(logger?: Logger) {
    this.logger = (logger ?? defaultLogger).child({ component: 'BrowserManager' });
    this.extractor = new ContentExtractor();
  }

  public async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.logger.info('Launching Chromium browser instance');
      this.browser = await chromium.launch({
        headless: true,
        // Chromium sandbox enabled. No --no-sandbox flag.
        args: [
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-component-update',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync'
        ]
      });

      this.browser.on('disconnected', () => {
        this.logger.warn('Chromium browser disconnected');
        this.browser = null;
      });
    }

    return this.browser;
  }

  public async renderAndExtract(options: RenderJobOptions): Promise<RenderResult> {
    const browser = await this.getBrowser();
    const timeoutMs = options.timeoutMs ?? 45000;
    const maxRequests = options.maxRequests ?? 100;

    // Fresh isolated browser context for each job
    const context: BrowserContext = await browser.newContext({
      proxy: { server: options.egressProxyUrl },
      serviceWorkers: 'block',
      ignoreHTTPSErrors: false,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (ReadableWeb/1.0)',
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: true
    });

    let page: Page | null = null;
    let requestCount = 0;

    try {
      page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);

      // Route filtering: block media, fonts, images, trackers, websockets
      await page.route('**/*', async (route) => {
        requestCount++;
        if (requestCount > maxRequests) {
          await route.abort('blockedbyclient');
          return;
        }

        const req = route.request();
        const resourceType = req.resourceType();
        const reqUrl = req.url();

        // Block prohibited resource types
        if (['image', 'media', 'font', 'websocket', 'manifest', 'other'].includes(resourceType)) {
          await route.abort('blockedbyclient');
          return;
        }

        // Only allow http and https
        if (!reqUrl.startsWith('http://') && !reqUrl.startsWith('https://')) {
          await route.abort('blockedbyclient');
          return;
        }

        await route.continue();
      });

      this.logger.debug(`Navigating to URL: ${options.url}`);

      // Navigate to URL
      const response = await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(timeoutMs, 30000)
      });

      if (!response) {
        throw new Error('UPSTREAM_ERROR: No response received from server');
      }

      const status = response.status();
      if (status >= 400) {
        throw new Error(`UPSTREAM_ERROR: HTTP server returned status ${status}`);
      }

      // Check Content-Type header on main document
      const contentType = response.headers()['content-type'] || '';
      const isHtml = contentType.includes('text/html') ||
                     contentType.includes('application/xhtml+xml') ||
                     contentType.includes('text/plain') ||
                     contentType === '';

      if (!isHtml) {
        throw new Error(`CONTENT_UNSUPPORTED: Unsupported document MIME type: ${contentType}`);
      }

      // Bounded wait for load state (up to 5 seconds extra, do not wait forever)
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {
        this.logger.debug('Page load state timed out, proceeding with DOM content');
      });

      const finalUrl = page.url();
      const rawHtml = await page.content();
      const article = this.extractor.extract(rawHtml, finalUrl);

      return {
        article,
        finalUrl,
        title: article.title,
        totalRequests: requestCount
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
