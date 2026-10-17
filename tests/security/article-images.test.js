"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_http_1 = __importDefault(require("node:http"));
const playwright_1 = require("playwright");
const images_js_1 = require("../../packages/rendering/dist/images.js");
const index_js_1 = require("../../packages/pdf/dist/index.js");
const index_js_2 = require("../../packages/observability/dist/index.js");
(0, node_test_1.it)('embeds article raster images through the browser proxy and prints them offline', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=', 'base64');
    let hits = 0;
    const proxy = node_http_1.default.createServer((_req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const browser = await playwright_1.chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const generator = new index_js_1.PdfGenerator();
    try {
        const context = await browser.newContext({ proxy: { server: `http://127.0.0.1:${proxy.address().port}` } });
        const html = await (0, images_js_1.embedArticleImages)('<figure><img src="/image.png" alt="Illustration"><figcaption>Caption</figcaption></figure><img src="http://127.0.0.1/private">', 'http://article.example/story', context, new index_js_2.Logger(), () => true);
        strict_1.default.equal(hits, 1);
        strict_1.default.ok(html.includes('data:image/png;base64,'));
        strict_1.default.ok(!html.includes('/private'));
        const clean = (0, index_js_1.sanitizeArticleContent)(html);
        strict_1.default.ok(clean.includes('data:image/png;base64,'));
        strict_1.default.ok(clean.includes('Caption'));
        strict_1.default.ok(!(0, index_js_1.sanitizeArticleContent)('<img src="data:image/svg+xml;base64,PHN2Zz4=">').includes('<img'));
        const result = await generator.generate({ jobId: 'images', data: { title: 'Images', sourceHostname: 'article.example', originalUrl: 'http://article.example/story', retrievedAt: new Date(), contentHtml: html } });
        strict_1.default.ok(result.pdfBuffer.toString('latin1').includes('/Subtype /Image'));
        strict_1.default.equal(hits, 1);
        await context.close();
    }
    finally {
        await generator.close();
        await browser.close();
        await new Promise(resolve => proxy.close(() => resolve()));
    }
});
//# sourceMappingURL=article-images.test.js.map