"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeHtml = escapeHtml;
exports.buildReaderHtml = buildReaderHtml;
const sanitizer_js_1 = require("./sanitizer.js");
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
function buildReaderHtml(data) {
    const safeTitle = escapeHtml(data.title || 'Readable Document');
    const safeHost = escapeHtml(data.sourceHostname);
    const safeOriginalUrl = escapeHtml(data.originalUrl);
    const safeFinalUrl = data.finalUrl && data.finalUrl !== data.originalUrl
        ? escapeHtml(data.finalUrl)
        : undefined;
    const isoTimestamp = data.retrievedAt.toISOString();
    const readableTimestamp = data.retrievedAt.toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }) + ' (MSK)';
    const sanitizedBody = (0, sanitizer_js_1.sanitizeArticleContent)(data.contentHtml);
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <style>
    @page {
      size: A4;
      margin: 20mm 15mm 20mm 15mm;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Liberation Sans", "DejaVu Sans", Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.65;
      color: #1a1a1a;
      background: #ffffff;
      margin: 0;
      padding: 0;
      word-wrap: break-word;
    }
    .header-box {
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 14pt;
      margin-bottom: 20pt;
    }
    .article-title {
      font-size: 20pt;
      font-weight: 700;
      line-height: 1.25;
      margin: 0 0 10pt 0;
      color: #0f172a;
    }
    .metadata {
      font-size: 9pt;
      color: #64748b;
      line-height: 1.4;
    }
    .metadata-row {
      margin-bottom: 3pt;
    }
    .metadata-label {
      font-weight: 600;
      color: #475569;
    }
    .url-link {
      color: #2563eb;
      text-decoration: none;
      word-break: break-all;
    }
    .content {
      font-size: 11pt;
    }
    h1, h2, h3, h4, h5, h6 {
      color: #0f172a;
      margin-top: 18pt;
      margin-bottom: 8pt;
      page-break-after: avoid;
    }
    h1 { font-size: 16pt; }
    h2 { font-size: 14pt; }
    h3 { font-size: 12pt; }
    p {
      margin-top: 0;
      margin-bottom: 10pt;
      text-align: justify;
    }
    blockquote {
      margin: 12pt 0;
      padding: 6pt 12pt;
      border-left: 4px solid #94a3b8;
      background: #f8fafc;
      color: #334155;
      font-style: italic;
    }
    pre {
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      padding: 8pt 10pt;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
      font-size: 9pt;
      line-height: 1.45;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      page-break-inside: avoid;
    }
    code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
      background: #f1f5f9;
      padding: 1.5pt 3pt;
      border-radius: 3px;
      font-size: 9.5pt;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 14pt 0;
      page-break-inside: avoid;
      font-size: 10pt;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 6pt 8pt;
      text-align: left;
    }
    th {
      background: #f8fafc;
      font-weight: 600;
    }
    ul, ol {
      margin-top: 0;
      margin-bottom: 10pt;
      padding-left: 20pt;
    }
    li {
      margin-bottom: 4pt;
    }
    hr {
      border: 0;
      height: 1px;
      background: #e2e8f0;
      margin: 16pt 0;
    }
  </style>
</head>
<body>
  <div class="header-box">
    <h1 class="article-title">${safeTitle}</h1>
    <div class="metadata">
      <div class="metadata-row">
        <span class="metadata-label">Источник:</span> ${safeHost}
      </div>
      <div class="metadata-row">
        <span class="metadata-label">URL:</span> <a href="${safeOriginalUrl}" class="url-link">${safeOriginalUrl}</a>
      </div>
      ${safeFinalUrl
        ? `<div class="metadata-row"><span class="metadata-label">Перенаправление:</span> <a href="${safeFinalUrl}" class="url-link">${safeFinalUrl}</a></div>`
        : ''}
      <div class="metadata-row">
        <span class="metadata-label">Сохранено:</span> ${readableTimestamp} (<span title="${isoTimestamp}">UTC: ${isoTimestamp}</span>)
      </div>
    </div>
  </div>
  <div class="content">
    ${sanitizedBody}
  </div>
</body>
</html>`;
}
//# sourceMappingURL=template.js.map