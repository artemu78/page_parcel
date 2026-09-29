import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseCommand,
  HELP_MESSAGE,
  getAppVersion,
  formatVersionMessage
} from '../../apps/webhook/dist/commands.js';
import {
  validateCallbackPayload,
  generateStableRandomId,
  isMessageNewEvent,
  createStatusKeyboard
} from '../../packages/vk/dist/index.js';

describe('Webhook - Command Parser', () => {
  it('parses /read command with valid URL', () => {
    const res = parseCommand('/read https://example.org/article?id=1');
    assert.deepEqual(res, {
      type: 'read',
      url: 'https://example.org/article?id=1'
    });
  });

  it('parses /status command with jobId', () => {
    const res = parseCommand('/status job_12345_abc');
    assert.deepEqual(res, {
      type: 'status',
      jobId: 'job_12345_abc'
    });
  });

  it('parses status command from button click payload', () => {
    const payload = JSON.stringify({ command: 'status', jobId: 'job_btn_999' });
    const res = parseCommand('📊 Проверить статус', payload);
    assert.deepEqual(res, {
      type: 'status',
      jobId: 'job_btn_999'
    });
  });

  it('parses /version command, synonyms, and payload', () => {
    assert.deepEqual(parseCommand('/version'), { type: 'version' });
    assert.deepEqual(parseCommand('/версия'), { type: 'version' });
    assert.deepEqual(parseCommand('версия'), { type: 'version' });

    const payload = JSON.stringify({ command: 'version' });
    assert.deepEqual(parseCommand('показать версию', payload), { type: 'version' });

    const msg = formatVersionMessage();
    assert.ok(msg.includes('Версия сервиса Readable Web:'));
    assert.ok(msg.includes('Среда:'));
  });

  it('parses /help command and synonyms', () => {
    assert.deepEqual(parseCommand('/help'), { type: 'help' });
    assert.deepEqual(parseCommand('?'), { type: 'help' });
    assert.deepEqual(parseCommand('помощь'), { type: 'help' });
    assert.ok(HELP_MESSAGE.includes('/version'));
  });

  it('treats unrecognized text properly', () => {
    const res = parseCommand('hello world');
    assert.deepEqual(res, {
      type: 'unrecognized',
      rawText: 'hello world'
    });
  });
});

describe('VK - Keyboard Generator', () => {
  it('generates valid inline status keyboard with job ID payload', () => {
    const rawJson = createStatusKeyboard('job_xyz_789');
    const keyboard = JSON.parse(rawJson);

    assert.equal(keyboard.inline, true);
    assert.equal(Array.isArray(keyboard.buttons), true);
    assert.equal(keyboard.buttons.length, 1);
    assert.equal(keyboard.buttons[0].length, 1);

    const button = keyboard.buttons[0][0];
    assert.equal(button.action.type, 'text');
    assert.equal(button.action.label, '📊 Проверить статус');
    assert.equal(button.color, 'primary');

    const payload = JSON.parse(button.action.payload);
    assert.deepEqual(payload, { command: 'status', jobId: 'job_xyz_789' });
  });
});

describe('VK - Callback API Validator', () => {
  const options = {
    expectedGroupId: 12345,
    expectedSecret: 'secret_code_123',
    confirmationCode: 'confirm_789'
  };

  it('returns confirmation response for confirmation event', () => {
    const payload = {
      type: 'confirmation',
      group_id: 12345,
      secret: 'secret_code_123'
    };

    const res = validateCallbackPayload(payload, options);
    assert.equal(res.valid, true);
    if (res.valid) {
      assert.equal(res.isConfirmation, true);
      assert.equal(res.response, 'confirm_789');
    }
  });

  it('validates message_new event and returns ok response', () => {
    const payload = {
      type: 'message_new',
      group_id: 12345,
      secret: 'secret_code_123',
      event_id: 'evt_001',
      object: {
        message: {
          id: 10,
          date: 1600000000,
          peer_id: 1001,
          from_id: 1001,
          text: '/read https://example.org/page'
        }
      }
    };

    const res = validateCallbackPayload(payload, options);
    assert.equal(res.valid, true);
    if (res.valid) {
      assert.equal(res.isConfirmation, false);
      assert.equal(res.response, 'ok');
      assert.equal(isMessageNewEvent(res.event), true);
    }
  });

  it('rejects payload with mismatched group_id', () => {
    const payload = {
      type: 'confirmation',
      group_id: 99999,
      secret: 'secret_code_123'
    };

    const res = validateCallbackPayload(payload, options);
    assert.equal(res.valid, false);
    if (!res.valid) {
      assert.equal(res.statusCode, 403);
    }
  });

  it('rejects payload with mismatched secret', () => {
    const payload = {
      type: 'confirmation',
      group_id: 12345,
      secret: 'wrong_secret'
    };

    const res = validateCallbackPayload(payload, options);
    assert.equal(res.valid, false);
    if (!res.valid) {
      assert.equal(res.statusCode, 403);
    }
  });
});

describe('VK - Deterministic Random ID', () => {
  it('generates consistent positive 31-bit integer for identical seeds', () => {
    const id1 = generateStableRandomId('job_123_success');
    const id2 = generateStableRandomId('job_123_success');
    assert.equal(id1, id2);
    assert.equal(typeof id1, 'number');
    assert.ok(id1 > 0);
    assert.ok(id1 <= 0x7fffffff);
  });

  it('generates distinct IDs for distinct phases', () => {
    const prepId = generateStableRandomId('job_123_prep');
    const successId = generateStableRandomId('job_123_success');
    const failId = generateStableRandomId('job_123_fail');

    assert.notEqual(prepId, successId);
    assert.notEqual(successId, failId);
    assert.notEqual(prepId, failId);
  });
});
