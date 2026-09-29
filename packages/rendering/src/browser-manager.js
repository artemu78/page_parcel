"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserManager = void 0;
const playwright_1 = require("playwright");
const observability_1 = require("@readable-web/observability");
const extractor_js_1 = require("./extractor.js");
class BrowserManager {
    browser = null;
    logger;
    extractor;
    constructor(logger) {
        this.logger = (logger ?? observability_1.defaultLogger).child({ component: 'BrowserManager' });
        this.extractor = new extractor_js_1.ContentExtractor();
    }
    async getBrowser() {
        if (!this.browser || !this.browser.isConnected()) {
            this.logger.info('Launching Chromium browser instance');
            this.browser = await playwright_1.chromium.launch({
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
    async renderAndExtract(options) {
        const browser = await this.getBrowser();
        const timeoutMs = options.timeoutMs ?? 45000;
        const envMaxRequests = process.env.MAX_REQUESTS_PER_JOB ? parseInt(process.env.MAX_REQUESTS_PER_JOB, 10) : undefined;
        const maxRequests = options.maxRequests ?? (envMaxRequests && !isNaN(envMaxRequests) ? envMaxRequests : 500);
        // Fresh isolated browser context for each job with mobile device emulation
        const mobileProfile = playwright_1.devices['Pixel 7'];
        const context = await browser.newContext({
            ...mobileProfile,
            proxy: { server: options.egressProxyUrl },
            serviceWorkers: 'block',
            ignoreHTTPSErrors: false,
            javaScriptEnabled: true
        });
        let page = null;
        let requestCount = 0;
        try {
            page = await context.newPage();
            page.setDefaultTimeout(timeoutMs);
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
            }
            catch (navErr) {
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
                const pageTitle = await page.title().catch(() => '');
                throw new Error(`UPSTREAM_ERROR: HTTP server returned status ${status}${pageTitle ? ` ("${pageTitle.trim()}")` : ''} for ${options.url}${finalUrl !== options.url ? ` (redirected to ${finalUrl})` : ''}`);
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
            await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {
                this.logger.debug('Page load state timed out, proceeding with DOM content');
            });
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
            }
            catch (extractErr) {
                if (extractErr instanceof extractor_js_1.ContentExtractionError && extractErr.diagnostics) {
                    extractErr.diagnostics.finalUrl = currentUrl;
                    extractErr.diagnostics.httpStatus = status;
                    extractErr.diagnostics.totalRequests = requestCount;
                    extractErr.message = `${extractErr.message} (finalUrl: ${currentUrl}, status: ${status}, requests: ${requestCount}${currentUrl !== options.url ? ', redirected: true' : ''})`;
                }
                throw extractErr;
            }
        }
        finally {
            if (page) {
                await page.close().catch(() => { });
            }
            await context.close().catch(() => { });
        }
    }
    async close() {
        if (this.browser) {
            await this.browser.close().catch(() => { });
            this.browser = null;
        }
    }
}
exports.BrowserManager = BrowserManager;
//# sourceMappingURL=browser-manager.js.map