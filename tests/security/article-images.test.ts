import { it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { embedArticleImages } from '../../packages/rendering/dist/images.js';
import { PdfGenerator, sanitizeArticleContent } from '../../packages/pdf/dist/index.js';
import { Logger } from '../../packages/observability/dist/index.js';

it('embeds article raster images through the browser proxy and prints them offline', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=', 'base64');
  let hits = 0;
  const proxy = http.createServer((_req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const generator = new PdfGenerator();
  try {
    const context = await browser.newContext({ proxy: { server: `http://127.0.0.1:${(proxy.address() as any).port}` } });
    const html = await embedArticleImages('<figure><img src="/image.png" alt="Illustration"><figcaption>Caption</figcaption></figure><img src="http://127.0.0.1/private">', 'http://article.example/story', context, new Logger(), () => true);
    assert.equal(hits, 1);
    assert.ok(html.includes('data:image/png;base64,'));
    assert.ok(!html.includes('/private'));
    const clean = sanitizeArticleContent(html);
    assert.ok(clean.includes('data:image/png;base64,'));
    assert.ok(clean.includes('Caption'));
    assert.ok(!sanitizeArticleContent('<img src="data:image/svg+xml;base64,PHN2Zz4=">').includes('<img'));
    const result = await generator.generate({ jobId: 'images', data: { title: 'Images', sourceHostname: 'article.example', originalUrl: 'http://article.example/story', retrievedAt: new Date(), contentHtml: html } });
    assert.ok(result.pdfBuffer.toString('latin1').includes('/Subtype /Image'));
    assert.equal(hits, 1);
    await context.close();
  } finally {
    await generator.close();
    await browser.close();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});
