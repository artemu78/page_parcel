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
const node_test_1 = require("node:test");
const assert = __importStar(require("node:assert/strict"));
const index_js_1 = require("../../packages/pdf/dist/index.js");
(0, node_test_1.describe)('PDF - Sanitizer', () => {
    (0, node_test_1.it)('strips dangerous executable elements and event handlers', () => {
        const dirtyHtml = `
      <h1>Заголовок статьи</h1>
      <script>alert("XSS")</script>
      <p onclick="alert('click')">Текст параграфа с <a href="javascript:alert(1)">вредной ссылкой</a>.</p>
      <iframe src="http://evil.com"></iframe>
      <img src="http://evil.com/tracker.png" />
      <form action="/steal"><input name="token" value="secret"/></form>
      <style>body { display: none; }</style>
    `;
        const clean = (0, index_js_1.sanitizeArticleContent)(dirtyHtml);
        assert.ok(clean.includes('<h1>Заголовок статьи</h1>'));
        assert.ok(clean.includes('Текст параграфа с'));
        assert.ok(clean.includes('вредной ссылкой</a>'));
        assert.ok(!clean.includes('<script'));
        assert.ok(!clean.includes('alert('));
        assert.ok(!clean.includes('<iframe'));
        assert.ok(!clean.includes('<img'));
        assert.ok(!clean.includes('<form'));
        assert.ok(!clean.includes('<input'));
        assert.ok(!clean.includes('<style'));
        assert.ok(!clean.includes('onclick'));
        assert.ok(!clean.includes('javascript:'));
    });
    (0, node_test_1.it)('preserves allowed structure: headings, lists, tables, code blocks', () => {
        const validHtml = `
      <h2>Подзаголовок</h2>
      <ul>
        <li>Пункт 1</li>
        <li>Пункт 2</li>
      </ul>
      <pre><code>const a = 42;</code></pre>
      <table>
        <thead><tr><th>Колонка 1</th><th>Колонка 2</th></tr></thead>
        <tbody><tr><td>А</td><td>Б</td></tr></tbody>
      </table>
    `;
        const clean = (0, index_js_1.sanitizeArticleContent)(validHtml);
        assert.ok(clean.includes('<h2>Подзаголовок</h2>'));
        assert.ok(clean.includes('<ul>'));
        assert.ok(clean.includes('<li>Пункт 1</li>'));
        assert.ok(clean.includes('<pre><code>const a = 42;</code></pre>'));
        assert.ok(clean.includes('<table>'));
        assert.ok(clean.includes('<th>Колонка 1</th>'));
    });
    (0, node_test_1.it)('secures external links with rel="noopener noreferrer"', () => {
        const htmlWithLink = '<p><a href="https://example.org/source">Ссылка на источник</a></p>';
        const clean = (0, index_js_1.sanitizeArticleContent)(htmlWithLink);
        assert.ok(clean.includes('href="https://example.org/source"'));
        assert.ok(clean.includes('rel="noopener noreferrer"'));
    });
});
(0, node_test_1.describe)('PDF - Reader Template and Filename Generation', () => {
    (0, node_test_1.it)('constructs reader HTML with Cyrillic text and metadata headers', () => {
        const html = (0, index_js_1.buildReaderHtml)({
            title: 'Введение в архитектуру',
            sourceHostname: 'habr.com',
            originalUrl: 'https://habr.com/ru/articles/123456/',
            retrievedAt: new Date('2026-09-28T12:00:00Z'),
            contentHtml: '<p>Текст статьи на русском языке.</p>'
        });
        assert.ok(html.includes('Введение в архитектуру'));
        assert.ok(html.includes('habr.com'));
        assert.ok(html.includes('https://habr.com/ru/articles/123456/'));
        assert.ok(html.includes('Текст статьи на русском языке.'));
        assert.ok(html.includes('lang="ru"'));
    });
    (0, node_test_1.it)('generates safe sanitized filenames without directory traversal', () => {
        const gen = new index_js_1.PdfGenerator();
        const filename1 = gen.generateSafeFilename('job_101', 'Как программировать на TS?');
        const filename2 = gen.generateSafeFilename('job_102', '../../../etc/passwd');
        assert.ok(filename1.endsWith('.pdf'));
        assert.ok(!filename1.includes('/'));
        assert.ok(!filename1.includes('\\'));
        assert.ok(filename2.endsWith('.pdf'));
        assert.ok(!filename2.includes('..'));
        assert.ok(!filename2.includes('/'));
    });
});
//# sourceMappingURL=pdf-and-sanitizer.test.js.map