"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../../packages/jobs/dist/index.js");
const index_js_2 = require("../../packages/rendering/dist/index.js");
(0, node_test_1.describe)('Settings Parsing and Store', () => {
    (0, node_test_1.it)('parses AdminID and ErrorListeners correctly from various formats', () => {
        // 1. Valid JSON array, numeric AdminID, and MaxRequestsPerJob
        const s1 = (0, index_js_1.parseSettingsMap)({
            AdminID: '123456789',
            ErrorListeners: '[123456789, 987654321, 123456789]',
            MaxRequestsPerJob: '350'
        });
        strict_1.default.equal(s1.adminId, 123456789);
        strict_1.default.deepEqual(s1.errorListeners, [123456789, 987654321]); // deduplicated
        strict_1.default.equal(s1.maxRequestsPerJob, 350);
        // 2. Comma-separated string and case-insensitive keys
        const s2 = (0, index_js_1.parseSettingsMap)({
            adminid: ' 555666 ',
            errorlisteners: ' 100, 200, 300, 100 '
        });
        strict_1.default.equal(s2.adminId, 555666);
        strict_1.default.deepEqual(s2.errorListeners, [100, 200, 300]);
        // 3. Empty or invalid values
        const s3 = (0, index_js_1.parseSettingsMap)({
            AdminID: 'not-a-number',
            ErrorListeners: 'invalid, [broken'
        });
        strict_1.default.equal(s3.adminId, undefined);
        strict_1.default.deepEqual(s3.errorListeners, []);
    });
    (0, node_test_1.it)('MemoryJobStore stores and retrieves runtime settings', async () => {
        const store = new index_js_1.MemoryJobStore();
        const initial = await store.getSettings();
        strict_1.default.equal(initial.adminId, undefined);
        strict_1.default.deepEqual(initial.errorListeners, []);
        await store.setSetting('AdminID', '999888');
        await store.setSetting('ErrorListeners', '[999888, 777666]');
        const updated = await store.getSettings();
        strict_1.default.equal(updated.adminId, 999888);
        strict_1.default.deepEqual(updated.errorListeners, [999888, 777666]);
        strict_1.default.equal(updated.raw['AdminID'], '999888');
        // Test deleting settings
        await store.deleteSetting('AdminID');
        await store.deleteSetting('ErrorListeners');
        const afterDelete = await store.getSettings();
        strict_1.default.equal(afterDelete.raw['AdminID'], undefined);
        strict_1.default.equal(afterDelete.raw['ErrorListeners'], undefined);
    });
});
(0, node_test_1.describe)('ContentExtractor Error with Article Context and Diagnostics', () => {
    (0, node_test_1.it)('throws ContentExtractionError containing the Readability article and diagnostics when content is too short', () => {
        const extractor = new index_js_2.ContentExtractor(100);
        const shortHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Short Page Title</title></head>
        <body><article><p>Too short text</p></article></body>
      </html>
    `;
        strict_1.default.throws(() => extractor.extract(shortHtml, 'https://example.com/short'), (err) => {
            strict_1.default.ok(err instanceof index_js_2.ContentExtractionError);
            strict_1.default.ok(err.message.includes('Could not extract meaningful readable content'));
            strict_1.default.ok(err.message.includes('htmlLen'));
            strict_1.default.ok(err.message.includes('Short Page Title'));
            strict_1.default.ok(err.article !== undefined);
            strict_1.default.equal(err.article?.title, 'Short Page Title');
            strict_1.default.ok(typeof err.article?.textContent === 'string');
            // Check structured diagnostics
            strict_1.default.ok(err.diagnostics !== undefined);
            strict_1.default.equal(err.diagnostics.docTitle, 'Short Page Title');
            strict_1.default.ok(err.diagnostics.rawHtmlLength > 50);
            strict_1.default.ok(err.diagnostics.bodyTextLength > 0);
            strict_1.default.ok(err.diagnostics.semanticCandidatesFound.includes('article'));
            strict_1.default.equal(err.diagnostics.readabilityReturned, true);
            return true;
        });
    });
    (0, node_test_1.it)('diagnoses anti-bot / captcha challenge accurately', () => {
        const extractor = new index_js_2.ContentExtractor(100);
        const cloudflareHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Just a moment...</title></head>
        <body><p>Verify you are human by completing the action below.</p></body>
      </html>
    `;
        strict_1.default.throws(() => extractor.extract(cloudflareHtml, 'https://example.com/protected'), (err) => {
            strict_1.default.ok(err instanceof index_js_2.ContentExtractionError);
            strict_1.default.ok(err.diagnostics?.failureReason.includes('Anti-bot challenge'));
            strict_1.default.ok(err.message.includes('Anti-bot challenge'));
            strict_1.default.equal(err.diagnostics?.docTitle, 'Just a moment...');
            return true;
        });
    });
    (0, node_test_1.it)('diagnoses empty or blank page accurately', () => {
        const extractor = new index_js_2.ContentExtractor(100);
        const blankHtml = `<html><head></head><body></body></html>`;
        strict_1.default.throws(() => extractor.extract(blankHtml, 'https://example.com/blank'), (err) => {
            strict_1.default.ok(err instanceof index_js_2.ContentExtractionError);
            strict_1.default.ok(err.diagnostics?.failureReason.includes('empty or blank'));
            strict_1.default.equal(err.diagnostics?.bodyTextLength, 0);
            strict_1.default.equal(err.diagnostics?.readabilityReturned, false);
            return true;
        });
    });
    (0, node_test_1.it)('strips modal dialogs and cookie/consent banners so they are never parsed as article content', () => {
        const extractor = new index_js_2.ContentExtractor(100);
        const htmlWithCookieModal = `
      <!DOCTYPE html>
      <html>
        <head><title>Understanding Distributed Systems</title></head>
        <body>
          <main>
            <h1>Understanding Distributed Systems</h1>
            <p>Distributed systems are collections of independent computing entities that communicate with each other over a network. They enable high scalability, fault tolerance, and availability when designed carefully.</p>
            <p>In this comprehensive guide, we will explore consensus algorithms, replication strategies, partitioning, and the CAP theorem in depth.</p>
          </main>
          <footer>
            <dialog id="consent-container">
              <div id="consent-banner">
                <h3>Cookie settings</h3>
                <p>We use cookies to deliver and improve our services, analyze site usage, and customize your experience. Read our Cookie Policy here.</p>
                <button>Accept all cookies</button>
              </div>
            </dialog>
            <div class="privacy_choices_dialog">
              <p>Manage your privacy preferences and cookie consent options here.</p>
            </div>
          </footer>
        </body>
      </html>
    `;
        const article = extractor.extract(htmlWithCookieModal, 'https://example.com/systems');
        strict_1.default.equal(article.title, 'Understanding Distributed Systems');
        strict_1.default.ok(article.textContent.includes('Distributed systems are collections of independent'));
        strict_1.default.ok(!article.textContent.includes('Cookie settings'));
        strict_1.default.ok(!article.textContent.includes('Manage your privacy preferences'));
    });
    (0, node_test_1.it)('rejects pages where the only content is a cookie/consent banner', () => {
        const extractor = new index_js_2.ContentExtractor(100);
        const htmlWithOnlyCookieBanner = `
      <!DOCTYPE html>
      <html>
        <head><title>Some Blank Page</title></head>
        <body>
          <dialog id="consent-container">
            <div id="consent-banner">
              <h3>Cookie settings</h3>
              <p>We use cookies to deliver and improve our services, analyze site usage, and customize your experience. Read our Cookie Policy here for details.</p>
            </div>
          </dialog>
        </body>
      </html>
    `;
        strict_1.default.throws(() => extractor.extract(htmlWithOnlyCookieBanner, 'https://example.com/only-cookie'), (err) => {
            strict_1.default.ok(err instanceof index_js_2.ContentExtractionError);
            strict_1.default.ok(err.message.includes('Could not extract meaningful readable content'));
            return true;
        });
    });
});
(0, node_test_1.describe)('OpenRouter routing settings', () => {
    (0, node_test_1.it)('parses aliases case-insensitively, prefers named settings, and preserves explicit proxy disable', () => {
        const settings = (0, index_js_1.parseSettingsMap)({ baseurl: ' https://example.org/aws/api/v1/ ', PROXY: ' http://example.org:8080 ' });
        strict_1.default.equal(settings.openRouterBaseUrl, 'https://example.org/aws/api/v1/');
        strict_1.default.equal(settings.openRouterProxy, 'http://example.org:8080');
        const named = (0, index_js_1.parseSettingsMap)({ OpenRouterBaseUrl: 'https://example.org/named', BaseUrl: 'https://example.org/alias',
            OpenRouterProxy: '', Proxy: 'http://example.org:8080' });
        strict_1.default.equal(named.openRouterBaseUrl, 'https://example.org/named');
        strict_1.default.equal(named.openRouterProxy, '');
        const empty = (0, index_js_1.parseSettingsMap)({ BaseUrl: '  ' });
        strict_1.default.equal(empty.openRouterBaseUrl, undefined);
        strict_1.default.equal(empty.openRouterProxy, undefined);
    });
});
//# sourceMappingURL=settings-and-extraction.test.js.map