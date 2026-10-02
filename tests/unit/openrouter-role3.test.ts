import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { MemoryJobStore, MemoryQueueClient, OutboxService } from '../../packages/jobs/dist/index.js';
import { WebhookHandler } from '../../apps/webhook/dist/handler.js';
import { OpenRouterClient, splitMessage } from '../../apps/webhook/dist/openrouter.js';

describe('OpenRouter Message Splitting', () => {
  it('returns single chunk for text within limit', () => {
    const text = 'Hello world!';
    const chunks = splitMessage(text, 100);
    assert.deepEqual(chunks, ['Hello world!']);
  });

  it('splits long text gracefully on newlines or spaces', () => {
    const text = 'Line 1\nLine 2 is somewhat longer\nLine 3 is also long enough';
    const chunks = splitMessage(text, 25);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 25);
    }
    const combinedWords = chunks.join(' ').replace(/\s+/g, ' ');
    const expectedWords = text.replace(/\s+/g, ' ');
    assert.equal(combinedWords, expectedWords);
  });
});

describe('OpenRouterClient', () => {
  it('sends prompt and parses completion from API', async () => {
    let capturedBody: any;
    let capturedAuth: string | undefined;

    const mockServer = http.createServer((req, res) => {
      capturedAuth = req.headers['authorization'];
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        capturedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Response from mock LLM'
              }
            }
          ]
        }));
      });
    });

    await new Promise<void>((resolve) => mockServer.listen(0, resolve));
    const port = (mockServer.address() as any).port;

    try {
      const client = new OpenRouterClient({
        apiKey: 'test-api-key-123',
        baseUrl: `http://127.0.0.1:${port}`,
        defaultModel: 'test/default-model'
      });

      const reply = await client.complete({
        prompt: 'Tell me something',
        model: 'custom/model-abc',
        history: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }]
      });

      assert.equal(reply, 'Response from mock LLM');
      assert.equal(capturedAuth, 'Bearer test-api-key-123');
      assert.equal(capturedBody.model, 'custom/model-abc');
      assert.deepEqual(capturedBody.messages, [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }, { role: 'user', content: 'Tell me something' }]);
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });
});

describe('Role 3 AI Chat in WebhookHandler', () => {
  it('searches free text for role 3 users instead of sending it to OpenRouter', async () => {
    const store = new MemoryJobStore();
    const queue = new MemoryQueueClient();
    const outbox = new OutboxService({ jobStore: store, queueClient: queue });

    const sentReplies: Array<{ peerId: number; message: string }> = [];
    const mockVk = {
      sendMessage: async (params: any) => {
        sentReplies.push({ peerId: params.peerId, message: params.message });
        return 1;
      }
    };

    let openRouterCalled = false;
    let modelUsed: string | undefined;
    const mockOpenRouter = {
      complete: async (params: any) => {
        openRouterCalled = true;
        modelUsed = params.model;
        return `Hello from AI! You asked: "${params.prompt}"`;
      }
    };

    const webhook = new WebhookHandler({
      jobStore: store,
      outboxService: outbox,
      vkClient: mockVk as any,
      openRouterClient: mockOpenRouter as any,
      searchClient: { search: async () => [{ title: 'Погода', url: 'https://example.org/weather', snippet: 'Прогноз' }] },
      validationOptions: {
        expectedGroupId: 12345,
        expectedSecret: 'sec',
        confirmationCode: 'code'
      }
    });

    const role3UserId = 1234567;
    // Assign Role 3
    await store.addUserRole(role3UserId, 3);
    // Set custom model in Settings
    await store.setSetting('Model', 'custom/fast-llm');

    const messageEvent = {
      type: 'message_new',
      group_id: 12345,
      secret: 'sec',
      event_id: 'evt_role3_1',
      object: {
        message: {
          id: 55,
          from_id: role3UserId,
          peer_id: role3UserId,
          text: 'Какая сегодня погода?'
        }
      }
    };

    const res = await webhook.handleRequest(messageEvent);
    assert.equal(res.statusCode, 200);

    // Wait microtask for async message handling
    await new Promise((r) => setTimeout(r, 50));

    // Verify OpenRouter was called with model from Settings
    assert.equal(openRouterCalled, false);
    assert.equal(modelUsed, undefined);

    // Verify VK reply was sent to the user
    assert.equal(sentReplies.length, 2);
    assert.equal(sentReplies[0].peerId, role3UserId);
    assert.ok(sentReplies[1].message.includes('https://example.org/weather'));
  });

  it('does NOT send message to OpenRouter if user does not have Role 3', async () => {
    const store = new MemoryJobStore();
    const queue = new MemoryQueueClient();
    const outbox = new OutboxService({ jobStore: store, queueClient: queue });

    const sentReplies: Array<{ peerId: number; message: string }> = [];
    const mockVk = {
      sendMessage: async (params: any) => {
        sentReplies.push({ peerId: params.peerId, message: params.message });
        return 1;
      }
    };

    let openRouterCalled = false;
    const mockOpenRouter = {
      complete: async () => {
        openRouterCalled = true;
        return 'Should not be called';
      }
    };

    const webhook = new WebhookHandler({
      jobStore: store,
      outboxService: outbox,
      vkClient: mockVk as any,
      openRouterClient: mockOpenRouter as any,
      searchClient: { search: async () => [{ title: 'Погода', url: 'https://example.org/weather', snippet: 'Прогноз' }] },
      validationOptions: {
        expectedGroupId: 12345,
        expectedSecret: 'sec',
        confirmationCode: 'code'
      }
    });

    const normalUserId = 987654; // No role 3

    const messageEvent = {
      type: 'message_new',
      group_id: 12345,
      secret: 'sec',
      event_id: 'evt_normal_1',
      object: {
        message: {
          id: 56,
          from_id: normalUserId,
          peer_id: normalUserId,
          text: 'Привет!'
        }
      }
    };

    await webhook.handleRequest(messageEvent);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(openRouterCalled, false);
    assert.equal(sentReplies.length, 2);
    assert.ok(sentReplies[1].message.includes('https://example.org/weather'));
  });

  it('executes normal command even if user has Role 3', async () => {
    const store = new MemoryJobStore();
    const queue = new MemoryQueueClient();
    const outbox = new OutboxService({ jobStore: store, queueClient: queue });

    const sentReplies: Array<{ peerId: number; message: string }> = [];
    const mockVk = {
      sendMessage: async (params: any) => {
        sentReplies.push({ peerId: params.peerId, message: params.message });
        return 1;
      }
    };

    let openRouterCalled = false;
    const mockOpenRouter = {
      complete: async () => {
        openRouterCalled = true;
        return 'Should not be called';
      }
    };

    const webhook = new WebhookHandler({
      jobStore: store,
      outboxService: outbox,
      vkClient: mockVk as any,
      openRouterClient: mockOpenRouter as any,
      searchClient: { search: async () => [{ title: 'Погода', url: 'https://example.org/weather', snippet: 'Прогноз' }] },
      validationOptions: {
        expectedGroupId: 12345,
        expectedSecret: 'sec',
        confirmationCode: 'code'
      }
    });

    const role3UserId = 1234567;
    await store.addUserRole(role3UserId, 3);

    const messageEvent = {
      type: 'message_new',
      group_id: 12345,
      secret: 'sec',
      event_id: 'evt_role3_cmd',
      object: {
        message: {
          id: 57,
          from_id: role3UserId,
          peer_id: role3UserId,
          text: '/version'
        }
      }
    };

    await webhook.handleRequest(messageEvent);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(openRouterCalled, false);
    assert.equal(sentReplies.length, 1);
    assert.ok(sentReplies[0].message.includes('Версия сервиса Readable Web:'));
  });

  it('rejects Role 3 user if blocked', async () => {
    const store = new MemoryJobStore();
    const queue = new MemoryQueueClient();
    const outbox = new OutboxService({ jobStore: store, queueClient: queue });

    const sentReplies: Array<{ peerId: number; message: string }> = [];
    const mockVk = {
      sendMessage: async (params: any) => {
        sentReplies.push({ peerId: params.peerId, message: params.message });
        return 1;
      }
    };

    const webhook = new WebhookHandler({
      jobStore: store,
      outboxService: outbox,
      vkClient: mockVk as any,
      openRouterClient: { complete: async () => 'Should not be called' } as any,
      validationOptions: {
        expectedGroupId: 12345,
        expectedSecret: 'sec',
        confirmationCode: 'code'
      }
    });

    const blockedRole3UserId = 888999;
    await store.addUserRole(blockedRole3UserId, 3);
    await store.upsertUserAccess(blockedRole3UserId);
    await store.setUserStatus(blockedRole3UserId, 1); // Blocked

    const messageEvent = {
      type: 'message_new',
      group_id: 12345,
      secret: 'sec',
      event_id: 'evt_role3_blocked',
      object: {
        message: {
          id: 58,
          from_id: blockedRole3UserId,
          peer_id: blockedRole3UserId,
          text: 'Привет!'
        }
      }
    };

    await webhook.handleRequest(messageEvent);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(sentReplies.length, 1);
    assert.ok(sentReplies[0].message.includes('заблокирован'));
  });
});
