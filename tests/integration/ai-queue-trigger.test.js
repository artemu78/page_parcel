"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const server_js_1 = require("../../apps/worker/dist/server.js");
const index_js_1 = require("../../packages/jobs/dist/index.js");
const handler_js_1 = require("../../apps/webhook/dist/handler.js");
const index_js_2 = require("../../packages/observability/dist/index.js");
(0, node_test_1.test)('YMQ trigger drives persisted AI request and waits for reply and reporting before acknowledgment', async () => {
    const jobStore = new index_js_1.MemoryJobStore();
    const conversationStore = new index_js_1.MemoryConversationStore();
    const queue = new index_js_1.MemoryQueueClient();
    const replies = [];
    const typing = [];
    let flushes = 0;
    const options = { jobStore, conversationStore, outboxService: new index_js_1.OutboxService({ jobStore, queueClient: queue }),
        vkClient: { setTyping: async (peerId) => { typing.push(peerId); }, sendMessage: async (p) => { replies.push(p); return 1; } },
        validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } };
    const webhook = new handler_js_1.WebhookHandler({ ...options, publishAiRequest: queue.publishAiRequest.bind(queue) });
    const callback = (id, text) => webhook.handleRequest({ type: 'message_new', group_id: 1, event_id: `trigger-${id}`,
        object: { message: { id, peer_id: 42, from_id: 42, text } } });
    let generated = 0;
    const aiWorker = new handler_js_1.WebhookHandler({ ...options, openRouterClient: { complete: async () => { generated++; return 'Queue-driven answer'; } } });
    const server = new server_js_1.WorkerServer({ port: 0, processor: { processJob: async () => { throw new Error('AI request reached PDF processor'); } },
        triggerSecret: 'test-secret', processAiRequest: message => aiWorker.processQueuedAiRequest(message) });
    (0, index_js_2.setExceptionReporter)({ capture() { }, async flush() { flushes++; } });
    try {
        await callback(1, '💬 Чат с ИИ');
        await callback(2, 'PRIVATE PROMPT');
        strict_1.default.equal(generated, 0);
        strict_1.default.deepEqual(typing, [42]);
        strict_1.default.ok(replies.every(r => !r.message.includes('Запрос принят')));
        const port = await server.start();
        const payload = JSON.stringify({ messages: [{ details: { message: { body: JSON.stringify(queue.aiMessages[0]) } } }] });
        const unauthorized = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: payload });
        strict_1.default.equal(unauthorized.status, 401);
        const invoke = () => fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: payload });
        const response = await invoke();
        strict_1.default.equal(response.status, 200);
        strict_1.default.equal(generated, 1);
        strict_1.default.deepEqual(typing, [42, 42]);
        strict_1.default.match(replies.at(-1).message, /Queue-driven answer/);
        strict_1.default.equal((await conversationStore.get(42)).lastAiRequest?.stage, 'completed');
        strict_1.default.equal(flushes, 3);
        strict_1.default.equal((await invoke()).status, 200);
        strict_1.default.equal(generated, 1);
    }
    finally {
        await server.stop();
        (0, index_js_2.setExceptionReporter)(undefined);
    }
});
//# sourceMappingURL=ai-queue-trigger.test.js.map