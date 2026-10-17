"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.embedArticleImages = embedArticleImages;
const jsdom_1 = require("jsdom");
const safe_network_1 = require("@readable-web/safe-network");
/** Only article images are fetched, through the job's validating browser proxy. */
async function embedArticleImages(html, baseUrl, context, logger, admitRequest) {
    const dom = new jsdom_1.JSDOM(html, { url: baseUrl });
    const images = [...dom.window.document.querySelectorAll('img')];
    const deadline = Date.now() + 15000;
    let bytes = 0;
    const cache = new Map();
    const page = await context.newPage();
    try {
        await page.route('**/*', async (route) => {
            if (!route.request().isNavigationRequest() || !admitRequest()) {
                await route.abort('blockedbyclient');
                return;
            }
            try {
                (0, safe_network_1.validateUrlSyntax)(route.request().url());
            }
            catch {
                await route.abort('blockedbyclient');
                return;
            }
            await route.continue();
        });
        for (const [index, image] of images.entries()) {
            const src = image.getAttribute('src') || image.getAttribute('data-src');
            image.removeAttribute('srcset');
            if (!src || index >= 12 || Date.now() >= deadline) {
                image.remove();
                continue;
            }
            let url;
            try {
                url = new URL(src, baseUrl).href;
                (0, safe_network_1.validateUrlSyntax)(url);
            }
            catch {
                image.remove();
                continue;
            }
            let embedded = cache.get(url);
            if (!embedded) {
                try {
                    const response = await page.goto(url, { waitUntil: 'load', timeout: Math.max(1, Math.min(3000, deadline - Date.now())) });
                    if (!response || !response.ok()) {
                        image.remove();
                        continue;
                    }
                    const body = await response.body();
                    // Raster signatures only; SVG and HTML are never embedded.
                    const mime = body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
                        : body[0] === 255 && body[1] === 216 && body[2] === 255 ? 'image/jpeg'
                            : ['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString()) ? 'image/gif'
                                : body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : undefined;
                    if (!mime || body.length > 2 * 1024 * 1024 || bytes + body.length > 8 * 1024 * 1024) {
                        image.remove();
                        continue;
                    }
                    bytes += body.length;
                    embedded = `data:${mime};base64,${body.toString('base64')}`;
                    cache.set(url, embedded);
                }
                catch (error) {
                    logger.exception(error, 'Fetch article image');
                    image.remove();
                    continue;
                }
            }
            image.setAttribute('src', embedded);
        }
        return dom.window.document.body.innerHTML;
    }
    finally {
        await page.close().catch(error => logger.exception(error, 'Close article image browser'));
        dom.window.close();
    }
}
//# sourceMappingURL=images.js.map