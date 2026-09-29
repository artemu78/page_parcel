import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

export interface ExtractedArticle {
  title: string;
  byline?: string;
  excerpt?: string;
  contentHtml: string;
  textContent: string;
  length: number;
}

export interface ExtractionDiagnostics {
  rawHtmlLength: number;
  docTitle?: string;
  bodyTextLength: number;
  bodyTextSnippet?: string;
  failureReason: string;
  readabilityAttempted: boolean;
  readabilityReturned: boolean;
  readabilityTextLength?: number;
  semanticCandidatesFound: string[];
  finalUrl?: string;
  httpStatus?: number;
  totalRequests?: number;
}

export class ContentExtractionError extends Error {
  public article: any;
  public diagnostics?: ExtractionDiagnostics;

  constructor(message: string, article?: any, diagnostics?: ExtractionDiagnostics) {
    super(message);
    this.name = 'ContentExtractionError';
    this.article = article ?? null;
    this.diagnostics = diagnostics;
  }
}

export class ContentExtractor {
  private minTextLength: number;

  constructor(minTextLength = 100) {
    this.minTextLength = minTextLength;
  }

  public extract(rawHtml: string, pageUrl: string): ExtractedArticle {
    if (!rawHtml || rawHtml.trim().length === 0) {
      throw new Error('CONTENT_EMPTY: Page response body is empty');
    }

    const dom = new JSDOM(rawHtml, { url: pageUrl });
    const doc = dom.window.document;

    // Collect DOM diagnostics for troubleshooting
    const docTitle = doc.title?.trim() || undefined;
    const rawBodyText = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
    const bodyTextLength = rawBodyText.length;
    const bodyTextSnippet = bodyTextLength > 0
      ? (bodyTextLength > 200 ? rawBodyText.slice(0, 200) + '...' : rawBodyText)
      : undefined;

    const candidateSelectors = [
      'article',
      'main',
      '[role="main"]',
      '.markdown-body',
      '.documentation-content',
      '#content',
      '.content',
      '#main-content'
    ];
    const semanticCandidatesFound = candidateSelectors.filter(sel => doc.querySelector(sel) !== null);

    // Strip modal dialogs and cookie/consent banners so they are never parsed as the article
    const cookieSelectors = [
      'dialog',
      '[role="dialog"]',
      '[aria-modal="true"]',
      '.privacy_choices_dialog',
      '[id*="consent-banner" i]',
      '[id*="consent-container" i]',
      '[id*="consent-modal" i]',
      '[id*="cookie-banner" i]',
      '[id*="cookie-notice" i]',
      '[id*="cookie-consent" i]',
      '[id*="cookie-bar" i]',
      '[id*="cookie-law" i]',
      '[class*="consent-banner" i]',
      '[class*="consent-container" i]',
      '[class*="consent-modal" i]',
      '[class*="cookie-banner" i]',
      '[class*="cookie-notice" i]',
      '[class*="cookie-consent" i]',
      '[class*="cookie-bar" i]',
      '[class*="cookie-popup" i]',
      '[class*="privacy-choices" i]',
      '[id*="privacy-choices" i]',
      '#onetrust-consent-sdk',
      '#CybotCookiebotDialog'
    ];
    for (const sel of cookieSelectors) {
      try {
        doc.querySelectorAll(sel).forEach(el => el.remove());
      } catch {
        // Ignore any selector syntax exceptions
      }
    }

    // 1. Try Readability first
    let article: any = null;
    let readabilityAttempted = true;
    let readabilityReturned = false;
    let readabilityTextLength: number | undefined;

    try {
      const reader = new Readability(doc);
      article = reader.parse();

      if (article) {
        readabilityReturned = true;
        readabilityTextLength = article.textContent?.trim().length;
        if (article.textContent && article.textContent.trim().length >= this.minTextLength) {
          return {
            title: article.title || this.extractFallbackTitle(doc, pageUrl),
            byline: article.byline || undefined,
            excerpt: article.excerpt || undefined,
            contentHtml: article.content || '<p></p>',
            textContent: article.textContent.trim(),
            length: article.length || article.textContent.trim().length
          };
        }
      }
    } catch {
      // Fallback to semantic extraction
    }

    // 2. Semantic Fallback for documentation or non-standard article structures
    const semanticArticle = this.extractSemanticFallback(doc, pageUrl);
    if (semanticArticle && semanticArticle.textContent.length >= this.minTextLength) {
      return semanticArticle;
    }

    // Determine high-confidence failure reason
    let failureReason = `Neither Readability nor semantic selectors found sufficient text (extracted text < ${this.minTextLength} chars)`;
    const lowerTitle = (docTitle || '').toLowerCase();
    const lowerSnippet = (rawBodyText || '').slice(0, 300).toLowerCase();

    if (
      lowerTitle.includes('just a moment') ||
      lowerTitle.includes('cloudflare') ||
      lowerTitle.includes('ddos-guard') ||
      lowerTitle.includes('qrator') ||
      lowerTitle.includes('security check') ||
      lowerTitle.includes('captcha') ||
      lowerTitle.includes('robot') ||
      lowerSnippet.includes('verify you are human') ||
      lowerSnippet.includes('turnstile') ||
      lowerSnippet.includes('smartcaptcha') ||
      lowerSnippet.includes('проверка браузера') ||
      lowerSnippet.includes('капч')
    ) {
      failureReason = 'Anti-bot challenge or captcha detected (e.g. Cloudflare, DDoS-Guard, QRATOR, SmartCaptcha)';
    } else if (
      lowerTitle.includes('log in') ||
      lowerTitle.includes('sign in') ||
      lowerTitle.includes('войти') ||
      lowerTitle.includes('авторизац') ||
      lowerTitle.includes('subscribe') ||
      lowerTitle.includes('paywall') ||
      lowerSnippet.includes('sign in to read') ||
      lowerSnippet.includes('войдите для чтения') ||
      lowerSnippet.includes('оформите подписку')
    ) {
      failureReason = 'Authentication or paywall barrier detected (login or subscription required)';
    } else if (bodyTextLength === 0 || rawHtml.trim().length < 80) {
      failureReason = 'Page HTML body is empty or blank (failed navigation, blank template, or JavaScript crashed)';
    } else if (article && article.textContent) {
      failureReason = `Readability found article, but text length (${readabilityTextLength} chars) was shorter than min required (${this.minTextLength} chars)`;
    }

    const diagnostics: ExtractionDiagnostics = {
      rawHtmlLength: rawHtml.length,
      docTitle,
      bodyTextLength,
      bodyTextSnippet,
      failureReason,
      readabilityAttempted,
      readabilityReturned,
      readabilityTextLength,
      semanticCandidatesFound
    };

    const detailParts: string[] = [
      `reason: ${failureReason}`,
      `htmlLen: ${rawHtml.length}`,
      `bodyTextLen: ${bodyTextLength}`
    ];
    if (docTitle) {
      detailParts.push(`title: ${JSON.stringify(docTitle)}`);
    }
    if (bodyTextSnippet) {
      detailParts.push(`bodyPreview: ${JSON.stringify(bodyTextSnippet)}`);
    }
    if (semanticCandidatesFound.length > 0) {
      detailParts.push(`semanticFound: [${semanticCandidatesFound.join(', ')}]`);
    }
    if (readabilityReturned) {
      detailParts.push(`readabilityLen: ${readabilityTextLength ?? 0}`);
    } else {
      detailParts.push(`readability: null`);
    }

    throw new ContentExtractionError(
      `CONTENT_UNSUPPORTED: Could not extract meaningful readable content (extracted text was shorter than ${this.minTextLength} characters). [${detailParts.join('; ')}]`,
      article,
      diagnostics
    );
  }

  private extractSemanticFallback(doc: Document, pageUrl: string): ExtractedArticle | null {
    // Selectors commonly used in documentation and single-page articles
    const candidates = [
      'article',
      'main',
      '[role="main"]',
      '.markdown-body',
      '.documentation-content',
      '#content',
      '.content',
      '#main-content'
    ];

    for (const selector of candidates) {
      const element = doc.querySelector(selector);
      if (element) {
        // Clone so we can strip noisy non-reading elements
        const clone = element.cloneNode(true) as HTMLElement;
        const noisySelectors = [
          'nav',
          'footer',
          'header',
          'aside',
          'script',
          'style',
          'noscript',
          'form',
          '.cookie-banner',
          '.ad',
          '.advertisement',
          '.comments'
        ];
        for (const noisy of noisySelectors) {
          clone.querySelectorAll(noisy).forEach(el => el.remove());
        }

        const textContent = clone.textContent?.trim() || '';
        if (textContent.length >= this.minTextLength) {
          return {
            title: this.extractFallbackTitle(doc, pageUrl),
            contentHtml: clone.innerHTML,
            textContent,
            length: textContent.length
          };
        }
      }
    }

    return null;
  }

  private extractFallbackTitle(doc: Document, pageUrl: string): string {
    const titleTag = doc.querySelector('title')?.textContent?.trim();
    if (titleTag && titleTag.length > 0) return titleTag;

    const h1Tag = doc.querySelector('h1')?.textContent?.trim();
    if (h1Tag && h1Tag.length > 0) return h1Tag;

    try {
      const parsed = new URL(pageUrl);
      return parsed.hostname + parsed.pathname;
    } catch {
      return 'Web Article';
    }
  }
}
