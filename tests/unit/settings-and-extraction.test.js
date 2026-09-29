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
        // 1. Valid JSON array and numeric AdminID
        const s1 = (0, index_js_1.parseSettingsMap)({
            AdminID: '123456789',
            ErrorListeners: '[123456789, 987654321, 123456789]'
        });
        strict_1.default.equal(s1.adminId, 123456789);
        strict_1.default.deepEqual(s1.errorListeners, [123456789, 987654321]); // deduplicated
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
(0, node_test_1.describe)('ContentExtractor Error with Article Context', () => {
    (0, node_test_1.it)('throws ContentExtractionError containing the Readability article when content is too short', () => {
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
            strict_1.default.ok(err.article !== undefined);
            strict_1.default.equal(err.article?.title, 'Short Page Title');
            strict_1.default.ok(typeof err.article?.textContent === 'string');
            return true;
        });
    });
});
//# sourceMappingURL=settings-and-extraction.test.js.map