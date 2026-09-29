import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSettingsMap, MemoryJobStore } from '../../packages/jobs/dist/index.js';
import { ContentExtractor, ContentExtractionError } from '../../packages/rendering/dist/index.js';

describe('Settings Parsing and Store', () => {
  it('parses AdminID and ErrorListeners correctly from various formats', () => {
    // 1. Valid JSON array, numeric AdminID, and MaxRequestsPerJob
    const s1 = parseSettingsMap({
      AdminID: '123456789',
      ErrorListeners: '[123456789, 987654321, 123456789]',
      MaxRequestsPerJob: '350'
    });
    assert.equal(s1.adminId, 123456789);
    assert.deepEqual(s1.errorListeners, [123456789, 987654321]); // deduplicated
    assert.equal(s1.maxRequestsPerJob, 350);

    // 2. Comma-separated string and case-insensitive keys
    const s2 = parseSettingsMap({
      adminid: ' 555666 ',
      errorlisteners: ' 100, 200, 300, 100 '
    });
    assert.equal(s2.adminId, 555666);
    assert.deepEqual(s2.errorListeners, [100, 200, 300]);

    // 3. Empty or invalid values
    const s3 = parseSettingsMap({
      AdminID: 'not-a-number',
      ErrorListeners: 'invalid, [broken'
    });
    assert.equal(s3.adminId, undefined);
    assert.deepEqual(s3.errorListeners, []);
  });

  it('MemoryJobStore stores and retrieves runtime settings', async () => {
    const store = new MemoryJobStore();

    const initial = await store.getSettings();
    assert.equal(initial.adminId, undefined);
    assert.deepEqual(initial.errorListeners, []);

    await store.setSetting('AdminID', '999888');
    await store.setSetting('ErrorListeners', '[999888, 777666]');

    const updated = await store.getSettings();
    assert.equal(updated.adminId, 999888);
    assert.deepEqual(updated.errorListeners, [999888, 777666]);
    assert.equal(updated.raw['AdminID'], '999888');

    // Test deleting settings
    await store.deleteSetting('AdminID');
    await store.deleteSetting('ErrorListeners');
    const afterDelete = await store.getSettings();
    assert.equal(afterDelete.raw['AdminID'], undefined);
    assert.equal(afterDelete.raw['ErrorListeners'], undefined);
  });
});

describe('ContentExtractor Error with Article Context and Diagnostics', () => {
  it('throws ContentExtractionError containing the Readability article and diagnostics when content is too short', () => {
    const extractor = new ContentExtractor(100);
    const shortHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Short Page Title</title></head>
        <body><article><p>Too short text</p></article></body>
      </html>
    `;

    assert.throws(
      () => extractor.extract(shortHtml, 'https://example.com/short'),
      (err: any) => {
        assert.ok(err instanceof ContentExtractionError);
        assert.ok(err.message.includes('Could not extract meaningful readable content'));
        assert.ok(err.message.includes('htmlLen'));
        assert.ok(err.message.includes('Short Page Title'));
        assert.ok(err.article !== undefined);
        assert.equal(err.article?.title, 'Short Page Title');
        assert.ok(typeof err.article?.textContent === 'string');

        // Check structured diagnostics
        assert.ok(err.diagnostics !== undefined);
        assert.equal(err.diagnostics.docTitle, 'Short Page Title');
        assert.ok(err.diagnostics.rawHtmlLength > 50);
        assert.ok(err.diagnostics.bodyTextLength > 0);
        assert.ok(err.diagnostics.semanticCandidatesFound.includes('article'));
        assert.equal(err.diagnostics.readabilityReturned, true);
        return true;
      }
    );
  });

  it('diagnoses anti-bot / captcha challenge accurately', () => {
    const extractor = new ContentExtractor(100);
    const cloudflareHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Just a moment...</title></head>
        <body><p>Verify you are human by completing the action below.</p></body>
      </html>
    `;

    assert.throws(
      () => extractor.extract(cloudflareHtml, 'https://example.com/protected'),
      (err: any) => {
        assert.ok(err instanceof ContentExtractionError);
        assert.ok(err.diagnostics?.failureReason.includes('Anti-bot challenge'));
        assert.ok(err.message.includes('Anti-bot challenge'));
        assert.equal(err.diagnostics?.docTitle, 'Just a moment...');
        return true;
      }
    );
  });

  it('diagnoses empty or blank page accurately', () => {
    const extractor = new ContentExtractor(100);
    const blankHtml = `<html><head></head><body></body></html>`;

    assert.throws(
      () => extractor.extract(blankHtml, 'https://example.com/blank'),
      (err: any) => {
        assert.ok(err instanceof ContentExtractionError);
        assert.ok(err.diagnostics?.failureReason.includes('empty or blank'));
        assert.equal(err.diagnostics?.bodyTextLength, 0);
        assert.equal(err.diagnostics?.readabilityReturned, false);
        return true;
      }
    );
  });

  it('strips modal dialogs and cookie/consent banners so they are never parsed as article content', () => {
    const extractor = new ContentExtractor(100);
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
    assert.equal(article.title, 'Understanding Distributed Systems');
    assert.ok(article.textContent.includes('Distributed systems are collections of independent'));
    assert.ok(!article.textContent.includes('Cookie settings'));
    assert.ok(!article.textContent.includes('Manage your privacy preferences'));
  });

  it('rejects pages where the only content is a cookie/consent banner', () => {
    const extractor = new ContentExtractor(100);
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

    assert.throws(
      () => extractor.extract(htmlWithOnlyCookieBanner, 'https://example.com/only-cookie'),
      (err: any) => {
        assert.ok(err instanceof ContentExtractionError);
        assert.ok(err.message.includes('Could not extract meaningful readable content'));
        return true;
      }
    );
  });
});

