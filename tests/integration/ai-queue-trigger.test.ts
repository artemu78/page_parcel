import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerServer } from '../../apps/worker/dist/server.js';
import { MemoryConversationStore, MemoryJobStore, MemoryQueueClient, OutboxService } from '../../packages/jobs/dist/index.js';
import { WebhookHandler } from '../../apps/webhook/dist/handler.js';
import { setExceptionReporter } from '../../packages/observability/dist/index.js';

test('YMQ trigger drives persisted AI request and waits for reply and reporting before acknowledgment', async () => {
  const jobStore = new MemoryJobStore(); const conversationStore = new MemoryConversationStore(); const queue = new MemoryQueueClient();
  const replies: any[] = []; const typing: number[] = []; let flushes = 0;
  const options = { jobStore, conversationStore, outboxService: new OutboxService({ jobStore, queueClient: queue }),
    vkClient: { setTyping: async (peerId: number) => { typing.push(peerId); }, sendMessage: async (p: any) => { replies.push(p); return 1; } } as any,
    validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } };
  const webhook = new WebhookHandler({ ...options, publishAiRequest: queue.publishAiRequest.bind(queue) });
  const callback = (id: number, text: string) => webhook.handleRequest({ type: 'message_new', group_id: 1, event_id: `trigger-${id}`,
    object: { message: { id, peer_id: 42, from_id: 42, text } } });
  let generated = 0;
  const aiWorker = new WebhookHandler({ ...options, openRouterClient: { complete: async () => { generated++; return 'Queue-driven answer'; } } as any });
  const server = new WorkerServer({ port: 0, processor: { processJob: async () => { throw new Error('AI request reached PDF processor'); } } as any,
    triggerSecret: 'test-secret', processAiRequest: message => aiWorker.processQueuedAiRequest(message) });
  setExceptionReporter({ capture() {}, async flush() { flushes++; } });
  try {
    await callback(1, '💬 Чат с ИИ'); await callback(2, 'PRIVATE PROMPT');
    assert.equal(generated, 0); assert.deepEqual(typing, [42]);
    assert.ok(replies.every(r => !r.message.includes('Запрос принят')));
    const port = await server.start();
    const payload = JSON.stringify({ messages: [{ details: { message: { body: JSON.stringify(queue.aiMessages[0]) } } }] });
    const unauthorized = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: payload });
    assert.equal(unauthorized.status, 401);
    const invoke = () => fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: payload });
    const response = await invoke();
    assert.equal(response.status, 200); assert.equal(generated, 1); assert.deepEqual(typing, [42, 42]);
    assert.match(replies.at(-1).message, /Queue-driven answer/);
    assert.equal((await conversationStore.get(42)).lastAiRequest?.stage, 'completed');
    assert.equal(flushes, 3);
    assert.equal((await invoke()).status, 200); assert.equal(generated, 1);
  } finally { await server.stop(); setExceptionReporter(undefined); }
});
