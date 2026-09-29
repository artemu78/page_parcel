"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PdfGenerator = void 0;
const crypto = __importStar(require("node:crypto"));
const playwright_1 = require("playwright");
const observability_1 = require("@readable-web/observability");
const template_js_1 = require("./template.js");
class PdfGenerator {
    browser = null;
    logger;
    maxPdfBytes;
    constructor(logger, maxPdfBytes = 10 * 1024 * 1024) {
        this.logger = (logger ?? observability_1.defaultLogger).child({ component: 'PdfGenerator' });
        this.maxPdfBytes = maxPdfBytes;
    }
    async getBrowser() {
        if (!this.browser || !this.browser.isConnected()) {
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
                    '--disable-background-networking'
                ]
            });
        }
        return this.browser;
    }
    generateSafeFilename(jobId, title) {
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
    async generate(options) {
        const browser = await this.getBrowser();
        const htmlContent = (0, template_js_1.buildReaderHtml)(options.data);
        // Completely isolated offline context with JavaScript and networking disabled
        const context = await browser.newContext({
            javaScriptEnabled: false,
            offline: true,
            viewport: { width: 1280, height: 800 }
        });
        let page = null;
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
            observability_1.metrics.pdfSizeBytes.observe(sizeBytes);
            if (sizeBytes > (options.maxBytes ?? this.maxPdfBytes)) {
                observability_1.metrics.failedJobsTotal.inc({ category: 'SIZE_EXCEEDED' });
                throw new Error(`Generated PDF size (${sizeBytes} bytes) exceeds limit of ${options.maxBytes ?? this.maxPdfBytes} bytes`);
            }
            const filename = this.generateSafeFilename(options.jobId, options.data.title);
            return {
                pdfBuffer,
                filename,
                sizeBytes
            };
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
exports.PdfGenerator = PdfGenerator;
//# sourceMappingURL=pdf-generator.js.map