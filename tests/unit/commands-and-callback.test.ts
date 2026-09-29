import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseCommand,
  HELP_MESSAGE,
  getAppVersion,
  formatVersionMessage
} from '../../apps/webhook/dist/commands.js';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  validateCallbackPayload,
  generateStableRandomId,
  isMessageNewEvent,
  createStatusKeyboard,
  VkApiClient
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

describe('VK - Api Client Error 912 Fallback', () => {
  it('automatically falls back to sending without keyboard when VK API returns error 912', async () => {
    const requests: Array<{ url: string; bodyParams: URLSearchParams }> = [];
    const server = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url!, `http://${req.headers.host}`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString();
      const bodyParams = new URLSearchParams(rawBody);
      requests.push({ url: req.url!, bodyParams });

      if (parsedUrl.pathname === '/messages.send') {
        const keyboard = bodyParams.get('keyboard');
        if (keyboard) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                error_code: 912,
                error_msg: 'This is a chat bot feature, change this status in settings: Chat bot feature'
              }
            })
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 998877 }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const client = new VkApiClient({
        token: 'test_token',
        baseUrl
      });

      const messageId = await client.sendMessage({
        peerId: 12345,
        message: 'Hello test',
        randomId: 1001,
        keyboard: '{"inline":true}'
      });

      assert.equal(messageId, 998877);
      assert.equal(requests.length, 2);
      assert.ok(requests[0].bodyParams.has('keyboard'));
      assert.ok(!requests[1].bodyParams.has('keyboard'));
      assert.equal(requests[1].bodyParams.get('message'), 'Hello test');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
