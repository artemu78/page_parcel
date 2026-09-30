import { chromium, Browser, BrowserContext, Page, devices } from 'playwright';
import { Logger, defaultLogger, UpstreamResponseError } from '@readable-web/observability';
import { ContentExtractor, ContentExtractionError, ExtractedArticle } from './extractor.js';

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
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          ...(process.platform === 'linux' ? ['--single-process'] : []),
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
    const envMaxRequests = process.env.MAX_REQUESTS_PER_JOB ? parseInt(process.env.MAX_REQUESTS_PER_JOB, 10) : undefined;
    const maxRequests = options.maxRequests ?? (envMaxRequests && !isNaN(envMaxRequests) ? envMaxRequests : 500);

    // Fresh isolated browser context for each job with mobile device emulation
    const mobileProfile = devices['Pixel 7'];
    const context: BrowserContext = await browser.newContext({
      ...mobileProfile,
      proxy: { server: options.egressProxyUrl },
      serviceWorkers: 'block',
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true
    });

    let page: Page | null = null;
    let requestCount = 0;

    try {
      page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      page.on('response', response => {
        this.logger.info('Article HTTP response', { httpStatus: response.status() });
      });

      // Route filtering: block media, fonts, images, trackers, websockets
      await page.route('**/*', async (route) => {
        const req = route.request();
        const resourceType = req.resourceType();
        const reqUrl = req.url();

        // Block prohibited resource types first (do NOT consume allowed request quota)
        if (['image', 'media', 'font', 'websocket', 'manifest', 'other'].includes(resourceType)) {
          await route.abort('blockedbyclient');
          return;
        }

        // Only allow http and https
        if (!reqUrl.startsWith('http://') && !reqUrl.startsWith('https://')) {
          await route.abort('blockedbyclient');
          return;
        }

        requestCount++;
        if (requestCount > maxRequests) {
          await route.abort('blockedbyclient');
          return;
        }

        await route.continue();
      });

      this.logger.debug(`Navigating to URL: ${options.url}`);

      // Navigate to URL with descriptive timeout
      let response;
      const navTimeout = Math.min(timeoutMs, 30000);
      try {
        response = await page.goto(options.url, {
          waitUntil: 'domcontentloaded',
          timeout: navTimeout
        });
      } catch (navErr: any) {
        const msg = navErr?.message || String(navErr);
        if (msg.includes('Timeout') || msg.includes('timeout')) {
          throw new Error(`TIMEOUT: Page navigation timed out after ${navTimeout}ms while loading ${options.url}`);
        }
        throw navErr;
      }

      if (!response) {
        throw new Error(`UPSTREAM_ERROR: No response received from server for ${options.url}`);
      }

      const status = response.status();
      const finalUrl = page.url();
      if (status >= 400) {
        throw new UpstreamResponseError(`UPSTREAM_ERROR: HTTP server returned status ${status}`, 'Article', status);
      }

      // Check Content-Type header on main document
      const contentType = response.headers()['content-type'] || '';
      const isHtml = contentType.includes('text/html') ||
                     contentType.includes('application/xhtml+xml') ||
                     contentType.includes('text/plain') ||
                     contentType === '';

      if (!isHtml) {
        throw new Error(`CONTENT_UNSUPPORTED: Unsupported document MIME type: "${contentType}" for ${options.url} (expected HTML or plain text)`);
      }

      // Bounded wait for load state (up to 5 seconds extra, do not wait forever)
      await page.waitForLoadState('load', { timeout: 5000 }).catch(err => {
        this.logger.exception(err, 'Wait for page load');
      });

      // Simulate fast scroll to trigger lazy loading, IntersectionObservers, and scroll-reveal animations
      try {
        await page.evaluate(async () => {
          const docHeight = Math.max(
            document.body?.scrollHeight || 0,
            document.documentElement?.scrollHeight || 0
          );
          if (docHeight > 0) {
            const viewportH = window.innerHeight || 800;
            const step = Math.max(viewportH * 2, 1000);
            const maxSteps = 15;
            let pos = 0;
            let steps = 0;
            while (pos < docHeight && steps < maxSteps) {
              pos += step;
              window.scrollTo(0, pos);
              window.dispatchEvent(new Event('scroll'));
              await new Promise((r) => setTimeout(r, 40));
              steps++;
            }
            window.scrollTo(0, 0);
            window.dispatchEvent(new Event('scroll'));
            await new Promise((r) => setTimeout(r, 40));
          }
        });
      } catch (err) {
        this.logger.exception(err, 'Scroll page');
      }

      const currentUrl = page.url();
      const rawHtml = await page.content();

      try {
        const article = this.extractor.extract(rawHtml, currentUrl);
        return {
          article,
          finalUrl: currentUrl,
          title: article.title,
          totalRequests: requestCount
        };
      } catch (extractErr: any) {
        if (extractErr instanceof ContentExtractionError && extractErr.diagnostics) {
          extractErr.diagnostics.finalUrl = currentUrl;
          extractErr.diagnostics.httpStatus = status;
          extractErr.diagnostics.totalRequests = requestCount;
          extractErr.message = `${extractErr.message} (finalUrl: ${currentUrl}, status: ${status}, requests: ${requestCount}${currentUrl !== options.url ? ', redirected: true' : ''})`;
        }
        throw extractErr;
      }
    } finally {
      if (page) {
        await page.close().catch(err => { this.logger.exception(err, 'Close browser resources'); });
      }
      await context.close().catch(err => { this.logger.exception(err, 'Close browser resources'); });
    }
  }

  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(err => { this.logger.exception(err, 'Close browser resources'); });
      this.browser = null;
    }
  }
}
