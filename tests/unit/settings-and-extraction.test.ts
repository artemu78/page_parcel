import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSettingsMap, MemoryJobStore } from '../../packages/jobs/dist/index.js';
import { ContentExtractor, ContentExtractionError } from '../../packages/rendering/dist/index.js';

describe('Settings Parsing and Store', () => {
  it('parses AdminID and ErrorListeners correctly from various formats', () => {
    // 1. Valid JSON array and numeric AdminID
    const s1 = parseSettingsMap({
      AdminID: '123456789',
      ErrorListeners: '[123456789, 987654321, 123456789]'
    });
    assert.equal(s1.adminId, 123456789);
    assert.deepEqual(s1.errorListeners, [123456789, 987654321]); // deduplicated

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

describe('ContentExtractor Error with Article Context', () => {
  it('throws ContentExtractionError containing the Readability article when content is too short', () => {
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
        assert.ok(err.article !== undefined);
        assert.equal(err.article?.title, 'Short Page Title');
        assert.ok(typeof err.article?.textContent === 'string');
        return true;
      }
    );
  });
});
