import { sanitizeArticleContent } from './sanitizer.js';

export type PdfFormat = 'mobile' | 'desktop' | 'a4' | 'a5';

export interface PdfMarginOptions {
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
}

export interface PdfFormattingParams {
  format?: PdfFormat;
  pageWidth?: string;
  pageHeight?: string;
  pageFormat?: string;
  margin?: PdfMarginOptions;
  fontSizePt?: number;
  titleFontSizePt?: number;
  h1FontSizePt?: number;
  h2FontSizePt?: number;
  h3FontSizePt?: number;
  lineHeight?: number;
  textAlign?: 'left' | 'justify';
  viewport?: {
    width: number;
    height: number;
  };
  footerMarginRight?: string;
  footerFontSizePt?: number;
}

export interface ResolvedPdfFormatting {
  format: PdfFormat;
  pageWidth?: string;
  pageHeight?: string;
  pageFormat?: string;
  margin: {
    top: string;
    bottom: string;
    left: string;
    right: string;
  };
  fontSizePt: number;
  titleFontSizePt: number;
  h1FontSizePt: number;
  h2FontSizePt: number;
  h3FontSizePt: number;
  lineHeight: number;
  textAlign: 'left' | 'justify';
  viewport: {
    width: number;
    height: number;
  };
  footerMarginRight: string;
  footerFontSizePt: number;
}

export const MOBILE_FORMATTING: ResolvedPdfFormatting = {
  format: 'mobile',
  pageWidth: '100mm',
  pageHeight: '180mm',
  margin: {
    top: '8mm',
    bottom: '8mm',
    left: '6mm',
    right: '6mm'
  },
  fontSizePt: 12,
  titleFontSizePt: 18,
  h1FontSizePt: 15,
  h2FontSizePt: 13.5,
  h3FontSizePt: 12,
  lineHeight: 1.55,
  textAlign: 'left',
  viewport: {
    width: 412,
    height: 915
  },
  footerMarginRight: '6mm',
  footerFontSizePt: 7.5
};

export const DESKTOP_FORMATTING: ResolvedPdfFormatting = {
  format: 'desktop',
  pageFormat: 'A4',
  pageWidth: '210mm',
  pageHeight: '297mm',
  margin: {
    top: '20mm',
    bottom: '20mm',
    left: '15mm',
    right: '15mm'
  },
  fontSizePt: 11,
  titleFontSizePt: 20,
  h1FontSizePt: 16,
  h2FontSizePt: 14,
  h3FontSizePt: 12,
  lineHeight: 1.65,
  textAlign: 'justify',
  viewport: {
    width: 1280,
    height: 800
  },
  footerMarginRight: '15mm',
  footerFontSizePt: 8
};

export const A5_FORMATTING: ResolvedPdfFormatting = {
  format: 'a5',
  pageFormat: 'A5',
  pageWidth: '148mm',
  pageHeight: '210mm',
  margin: {
    top: '12mm',
    bottom: '12mm',
    left: '10mm',
    right: '10mm'
  },
  fontSizePt: 11.5,
  titleFontSizePt: 18,
  h1FontSizePt: 15,
  h2FontSizePt: 13,
  h3FontSizePt: 11.5,
  lineHeight: 1.6,
  textAlign: 'left',
  viewport: {
    width: 600,
    height: 850
  },
  footerMarginRight: '10mm',
  footerFontSizePt: 7.5
};

export function resolvePdfFormatting(params?: PdfFormattingParams | PdfFormat): ResolvedPdfFormatting {
  const input = typeof params === 'string' ? { format: params } : (params ?? {});
  const basePreset = input.format === 'desktop' || input.format === 'a4'
    ? DESKTOP_FORMATTING
    : input.format === 'a5'
      ? A5_FORMATTING
      : MOBILE_FORMATTING;

  return {
    format: input.format ?? basePreset.format,
    pageWidth: input.pageWidth ?? (input.pageFormat ? undefined : basePreset.pageWidth),
    pageHeight: input.pageHeight ?? (input.pageFormat ? undefined : basePreset.pageHeight),
    pageFormat: input.pageFormat ?? (input.pageWidth ? undefined : basePreset.pageFormat),
    margin: {
      top: input.margin?.top ?? basePreset.margin.top,
      bottom: input.margin?.bottom ?? basePreset.margin.bottom,
      left: input.margin?.left ?? basePreset.margin.left,
      right: input.margin?.right ?? basePreset.margin.right
    },
    fontSizePt: input.fontSizePt ?? basePreset.fontSizePt,
    titleFontSizePt: input.titleFontSizePt ?? basePreset.titleFontSizePt,
    h1FontSizePt: input.h1FontSizePt ?? basePreset.h1FontSizePt,
    h2FontSizePt: input.h2FontSizePt ?? basePreset.h2FontSizePt,
    h3FontSizePt: input.h3FontSizePt ?? basePreset.h3FontSizePt,
    lineHeight: input.lineHeight ?? basePreset.lineHeight,
    textAlign: input.textAlign ?? basePreset.textAlign,
    viewport: {
      width: input.viewport?.width ?? basePreset.viewport.width,
      height: input.viewport?.height ?? basePreset.viewport.height
    },
    footerMarginRight: input.footerMarginRight ?? basePreset.footerMarginRight,
    footerFontSizePt: input.footerFontSizePt ?? basePreset.footerFontSizePt
  };
}

export interface ReaderTemplateData {
  title: string;
  sourceHostname: string;
  originalUrl: string;
  finalUrl?: string;
  retrievedAt: Date;
  contentHtml: string;
  formatting?: PdfFormattingParams | PdfFormat;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function buildReaderHtml(
  data: ReaderTemplateData,
  formatting?: PdfFormattingParams | PdfFormat
): string {
  const resolved = resolvePdfFormatting(formatting ?? data.formatting);
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

  const sanitizedBody = sanitizeArticleContent(data.contentHtml);

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <style>
    @page {
      ${
        resolved.pageWidth && resolved.pageHeight
          ? `size: ${resolved.pageWidth} ${resolved.pageHeight};`
          : resolved.pageFormat
            ? `size: ${resolved.pageFormat};`
            : `size: 100mm 180mm;`
      }
      margin: ${resolved.margin.top} ${resolved.margin.right} ${resolved.margin.bottom} ${resolved.margin.left};
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Liberation Sans", "DejaVu Sans", Arial, sans-serif;
      font-size: ${resolved.fontSizePt}pt;
      line-height: ${resolved.lineHeight};
      color: #1a1a1a;
      background: #ffffff;
      margin: 0;
      padding: 0;
      word-wrap: break-word;
    }
    .header-box {
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 10pt;
      margin-bottom: ${resolved.format === 'desktop' ? '20pt' : '12pt'};
    }
    .article-title {
      font-size: ${resolved.titleFontSizePt}pt;
      font-weight: 700;
      line-height: 1.25;
      margin: 0 0 8pt 0;
      color: #0f172a;
    }
    .metadata {
      font-size: ${resolved.format === 'desktop' ? '9pt' : '8.5pt'};
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
      font-size: ${resolved.fontSizePt}pt;
    }
    h1, h2, h3, h4, h5, h6 {
      color: #0f172a;
      margin-top: 14pt;
      margin-bottom: 6pt;
      page-break-after: avoid;
    }
    h1 { font-size: ${resolved.h1FontSizePt}pt; }
    h2 { font-size: ${resolved.h2FontSizePt}pt; }
    h3 { font-size: ${resolved.h3FontSizePt}pt; }
    p {
      margin-top: 0;
      margin-bottom: 8pt;
      text-align: ${resolved.textAlign};
    }
    blockquote {
      margin: 10pt 0;
      padding: 4pt 10pt;
      border-left: 3px solid #94a3b8;
      background: #f8fafc;
      color: #334155;
      font-style: italic;
    }
    pre {
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      padding: 6pt 8pt;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
      font-size: ${resolved.format === 'desktop' ? '9pt' : '8pt'};
      line-height: 1.4;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      page-break-inside: avoid;
    }
    code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
      background: #f1f5f9;
      padding: 1pt 3pt;
      border-radius: 3px;
      font-size: ${resolved.format === 'desktop' ? '9.5pt' : '8.5pt'};
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 12pt 0;
      page-break-inside: avoid;
      font-size: ${resolved.format === 'desktop' ? '10pt' : '8.5pt'};
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 4pt 6pt;
      text-align: left;
    }
    th {
      background: #f8fafc;
      font-weight: 600;
    }
    ul, ol {
      margin-top: 0;
      margin-bottom: 8pt;
      padding-left: 16pt;
    }
    li {
      margin-bottom: 3pt;
    }
    hr {
      border: 0;
      height: 1px;
      background: #e2e8f0;
      margin: 14pt 0;
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
      ${
        safeFinalUrl
          ? `<div class="metadata-row"><span class="metadata-label">Перенаправление:</span> <a href="${safeFinalUrl}" class="url-link">${safeFinalUrl}</a></div>`
          : ''
      }
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
