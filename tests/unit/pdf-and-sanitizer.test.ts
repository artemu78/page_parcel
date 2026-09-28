import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  sanitizeArticleContent,
  buildReaderHtml,
  PdfGenerator
} from '../../packages/pdf/dist/index.js';

describe('PDF - Sanitizer', () => {
  it('strips dangerous executable elements and event handlers', () => {
    const dirtyHtml = `
      <h1>Заголовок статьи</h1>
      <script>alert("XSS")</script>
      <p onclick="alert('click')">Текст параграфа с <a href="javascript:alert(1)">вредной ссылкой</a>.</p>
      <iframe src="http://evil.com"></iframe>
      <img src="http://evil.com/tracker.png" />
      <form action="/steal"><input name="token" value="secret"/></form>
      <style>body { display: none; }</style>
    `;

    const clean = sanitizeArticleContent(dirtyHtml);

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

  it('preserves allowed structure: headings, lists, tables, code blocks', () => {
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

    const clean = sanitizeArticleContent(validHtml);
    assert.ok(clean.includes('<h2>Подзаголовок</h2>'));
    assert.ok(clean.includes('<ul>'));
    assert.ok(clean.includes('<li>Пункт 1</li>'));
    assert.ok(clean.includes('<pre><code>const a = 42;</code></pre>'));
    assert.ok(clean.includes('<table>'));
    assert.ok(clean.includes('<th>Колонка 1</th>'));
  });

  it('secures external links with rel="noopener noreferrer"', () => {
    const htmlWithLink = '<p><a href="https://example.org/source">Ссылка на источник</a></p>';
    const clean = sanitizeArticleContent(htmlWithLink);
    assert.ok(clean.includes('href="https://example.org/source"'));
    assert.ok(clean.includes('rel="noopener noreferrer"'));
  });
});

describe('PDF - Reader Template and Filename Generation', () => {
  it('constructs reader HTML with Cyrillic text and metadata headers', () => {
    const html = buildReaderHtml({
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

  it('generates safe sanitized filenames without directory traversal', () => {
    const gen = new PdfGenerator();
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
