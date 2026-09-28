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

    // 1. Try Readability first
    try {
      const reader = new Readability(doc);
      const article = reader.parse();

      if (article && article.textContent && article.textContent.trim().length >= this.minTextLength) {
        return {
          title: article.title || this.extractFallbackTitle(doc, pageUrl),
          byline: article.byline || undefined,
          excerpt: article.excerpt || undefined,
          contentHtml: article.content || '<p></p>',
          textContent: article.textContent.trim(),
          length: article.length || article.textContent.trim().length
        };
      }
    } catch {
      // Fallback to semantic extraction
    }

    // 2. Semantic Fallback for documentation or non-standard article structures
    const semanticArticle = this.extractSemanticFallback(doc, pageUrl);
    if (semanticArticle && semanticArticle.textContent.length >= this.minTextLength) {
      return semanticArticle;
    }

    throw new Error(
      `CONTENT_UNSUPPORTED: Could not extract meaningful readable content (extracted text was shorter than ${this.minTextLength} characters)`
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
