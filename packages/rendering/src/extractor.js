"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContentExtractor = exports.ContentExtractionError = void 0;
const readability_1 = require("@mozilla/readability");
const jsdom_1 = require("jsdom");
class ContentExtractionError extends Error {
    article;
    diagnostics;
    constructor(message, article, diagnostics) {
        super(message);
        this.name = 'ContentExtractionError';
        this.article = article ?? null;
        this.diagnostics = diagnostics;
    }
}
exports.ContentExtractionError = ContentExtractionError;
class ContentExtractor {
    minTextLength;
    constructor(minTextLength = 100) {
        this.minTextLength = minTextLength;
    }
    extract(rawHtml, pageUrl) {
        if (!rawHtml || rawHtml.trim().length === 0) {
            throw new Error('CONTENT_EMPTY: Page response body is empty');
        }
        const dom = new jsdom_1.JSDOM(rawHtml, { url: pageUrl });
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
        // 1. Try Readability first
        let article = null;
        let readabilityAttempted = true;
        let readabilityReturned = false;
        let readabilityTextLength;
        try {
            const reader = new readability_1.Readability(doc);
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
        }
        catch {
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
        if (lowerTitle.includes('just a moment') ||
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
            lowerSnippet.includes('капч')) {
            failureReason = 'Anti-bot challenge or captcha detected (e.g. Cloudflare, DDoS-Guard, QRATOR, SmartCaptcha)';
        }
        else if (lowerTitle.includes('log in') ||
            lowerTitle.includes('sign in') ||
            lowerTitle.includes('войти') ||
            lowerTitle.includes('авторизац') ||
            lowerTitle.includes('subscribe') ||
            lowerTitle.includes('paywall') ||
            lowerSnippet.includes('sign in to read') ||
            lowerSnippet.includes('войдите для чтения') ||
            lowerSnippet.includes('оформите подписку')) {
            failureReason = 'Authentication or paywall barrier detected (login or subscription required)';
        }
        else if (bodyTextLength === 0 || rawHtml.trim().length < 80) {
            failureReason = 'Page HTML body is empty or blank (failed navigation, blank template, or JavaScript crashed)';
        }
        else if (article && article.textContent) {
            failureReason = `Readability found article, but text length (${readabilityTextLength} chars) was shorter than min required (${this.minTextLength} chars)`;
        }
        const diagnostics = {
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
        const detailParts = [
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
        }
        else {
            detailParts.push(`readability: null`);
        }
        throw new ContentExtractionError(`CONTENT_UNSUPPORTED: Could not extract meaningful readable content (extracted text was shorter than ${this.minTextLength} characters). [${detailParts.join('; ')}]`, article, diagnostics);
    }
    extractSemanticFallback(doc, pageUrl) {
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
                const clone = element.cloneNode(true);
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
    extractFallbackTitle(doc, pageUrl) {
        const titleTag = doc.querySelector('title')?.textContent?.trim();
        if (titleTag && titleTag.length > 0)
            return titleTag;
        const h1Tag = doc.querySelector('h1')?.textContent?.trim();
        if (h1Tag && h1Tag.length > 0)
            return h1Tag;
        try {
            const parsed = new URL(pageUrl);
            return parsed.hostname + parsed.pathname;
        }
        catch {
            return 'Web Article';
        }
    }
}
exports.ContentExtractor = ContentExtractor;
//# sourceMappingURL=extractor.js.map