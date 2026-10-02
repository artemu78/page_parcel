"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const http = __importStar(require("node:http"));
const index_js_1 = require("../../packages/jobs/dist/index.js");
const handler_js_1 = require("../../apps/webhook/dist/handler.js");
const openrouter_js_1 = require("../../apps/webhook/dist/openrouter.js");
(0, node_test_1.describe)('OpenRouter Message Splitting', () => {
    (0, node_test_1.it)('returns single chunk for text within limit', () => {
        const text = 'Hello world!';
        const chunks = (0, openrouter_js_1.splitMessage)(text, 100);
        strict_1.default.deepEqual(chunks, ['Hello world!']);
    });
    (0, node_test_1.it)('splits long text gracefully on newlines or spaces', () => {
        const text = 'Line 1\nLine 2 is somewhat longer\nLine 3 is also long enough';
        const chunks = (0, openrouter_js_1.splitMessage)(text, 25);
        strict_1.default.ok(chunks.length > 1);
        for (const chunk of chunks) {
            strict_1.default.ok(chunk.length <= 25);
        }
        const combinedWords = chunks.join(' ').replace(/\s+/g, ' ');
        const expectedWords = text.replace(/\s+/g, ' ');
        strict_1.default.equal(combinedWords, expectedWords);
    });
});
(0, node_test_1.describe)('OpenRouterClient', () => {
    (0, node_test_1.it)('sends prompt and parses completion from API', async () => {
        let capturedBody;
        let capturedAuth;
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
        await new Promise((resolve) => mockServer.listen(0, resolve));
        const port = mockServer.address().port;
        try {
            const client = new openrouter_js_1.OpenRouterClient({
                apiKey: 'test-api-key-123',
                baseUrl: `http://127.0.0.1:${port}`,
                defaultModel: 'test/default-model'
            });
            const reply = await client.complete({
                prompt: 'Tell me something',
                model: 'custom/model-abc',
                history: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }]
            });
            strict_1.default.equal(reply, 'Response from mock LLM');
            strict_1.default.equal(capturedAuth, 'Bearer test-api-key-123');
            strict_1.default.equal(capturedBody.model, 'custom/model-abc');
            strict_1.default.deepEqual(capturedBody.messages, [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }, { role: 'user', content: 'Tell me something' }]);
        }
        finally {
            await new Promise((resolve) => mockServer.close(() => resolve()));
        }
    });
});
(0, node_test_1.describe)('Role 3 AI Chat in WebhookHandler', () => {
    (0, node_test_1.it)('searches free text for role 3 users instead of sending it to OpenRouter', async () => {
        const store = new index_js_1.MemoryJobStore();
        const queue = new index_js_1.MemoryQueueClient();
        const outbox = new index_js_1.OutboxService({ jobStore: store, queueClient: queue });
        const sentReplies = [];
        const mockVk = {
            sendMessage: async (params) => {
                sentReplies.push({ peerId: params.peerId, message: params.message });
                return 1;
            }
        };
        let openRouterCalled = false;
        let modelUsed;
        const mockOpenRouter = {
            complete: async (params) => {
                openRouterCalled = true;
                modelUsed = params.model;
                return `Hello from AI! You asked: "${params.prompt}"`;
            }
        };
        const webhook = new handler_js_1.WebhookHandler({
            jobStore: store,
            outboxService: outbox,
            vkClient: mockVk,
            openRouterClient: mockOpenRouter,
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
        strict_1.default.equal(res.statusCode, 200);
        // Wait microtask for async message handling
        await new Promise((r) => setTimeout(r, 50));
        // Verify OpenRouter was called with model from Settings
        strict_1.default.equal(openRouterCalled, false);
        strict_1.default.equal(modelUsed, undefined);
        // Verify VK reply was sent to the user
        strict_1.default.equal(sentReplies.length, 2);
        strict_1.default.equal(sentReplies[0].peerId, role3UserId);
        strict_1.default.ok(sentReplies[1].message.includes('https://example.org/weather'));
    });
    (0, node_test_1.it)('does NOT send message to OpenRouter if user does not have Role 3', async () => {
        const store = new index_js_1.MemoryJobStore();
        const queue = new index_js_1.MemoryQueueClient();
        const outbox = new index_js_1.OutboxService({ jobStore: store, queueClient: queue });
        const sentReplies = [];
        const mockVk = {
            sendMessage: async (params) => {
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
        const webhook = new handler_js_1.WebhookHandler({
            jobStore: store,
            outboxService: outbox,
            vkClient: mockVk,
            openRouterClient: mockOpenRouter,
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
        strict_1.default.equal(openRouterCalled, false);
        strict_1.default.equal(sentReplies.length, 2);
        strict_1.default.ok(sentReplies[1].message.includes('https://example.org/weather'));
    });
    (0, node_test_1.it)('executes normal command even if user has Role 3', async () => {
        const store = new index_js_1.MemoryJobStore();
        const queue = new index_js_1.MemoryQueueClient();
        const outbox = new index_js_1.OutboxService({ jobStore: store, queueClient: queue });
        const sentReplies = [];
        const mockVk = {
            sendMessage: async (params) => {
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
        const webhook = new handler_js_1.WebhookHandler({
            jobStore: store,
            outboxService: outbox,
            vkClient: mockVk,
            openRouterClient: mockOpenRouter,
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
        strict_1.default.equal(openRouterCalled, false);
        strict_1.default.equal(sentReplies.length, 1);
        strict_1.default.ok(sentReplies[0].message.includes('Версия сервиса Readable Web:'));
    });
    (0, node_test_1.it)('rejects Role 3 user if blocked', async () => {
        const store = new index_js_1.MemoryJobStore();
        const queue = new index_js_1.MemoryQueueClient();
        const outbox = new index_js_1.OutboxService({ jobStore: store, queueClient: queue });
        const sentReplies = [];
        const mockVk = {
            sendMessage: async (params) => {
                sentReplies.push({ peerId: params.peerId, message: params.message });
                return 1;
            }
        };
        const webhook = new handler_js_1.WebhookHandler({
            jobStore: store,
            outboxService: outbox,
            vkClient: mockVk,
            openRouterClient: { complete: async () => 'Should not be called' },
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
        strict_1.default.equal(sentReplies.length, 1);
        strict_1.default.ok(sentReplies[0].message.includes('заблокирован'));
    });
});
(0, node_test_1.describe)('OpenRouter routing and safe diagnostics', () => {
    (0, node_test_1.it)('uses the database reverse proxy and logs 403 diagnostics without exporting private response data', async () => {
        const records = [];
        const logger = { child() { return this; }, info(message, context) { records.push({ message, context }); }, exception() { } };
        let requests = 0;
        const server = http.createServer((req, res) => {
            requests++;
            strict_1.default.equal(req.url, '/api/v1/chat/completions');
            res.writeHead(403, { 'Content-Type': 'application/json', 'x-request-id': 'upstream-403', 'cf-ray': 'abcd1234-IAD' });
            res.end(JSON.stringify({ error: { code: 403, message: 'Country not supported: PRIVATE-PROMPT sk-or-v1-private-key',
                    metadata: { flagged_input: 'PRIVATE-HISTORY', raw: 'PRIVATE-RESPONSE' } } }));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
            const store = new index_js_1.MemoryJobStore();
            await store.setSetting('BaseUrl', baseUrl);
            await store.setSetting('Model', 'test/model');
            const replies = [];
            const handler = new handler_js_1.WebhookHandler({ jobStore: store,
                outboxService: new index_js_1.OutboxService({ jobStore: store, queueClient: new index_js_1.MemoryQueueClient() }),
                openRouterClient: new openrouter_js_1.OpenRouterClient({ apiKey: 'sk-or-v1-private-key', baseUrl: 'http://127.0.0.1:1/unconfigured', logger: logger }),
                vkClient: { sendMessage: async (p) => { replies.push(p); return 1; } },
                validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } });
            const send = (id, text, payload) => handler.processMessageEvent({ event_id: `proxy-${id}`,
                object: { message: { id, peer_id: 42, from_id: 42, text, payload: payload && JSON.stringify(payload) } } });
            await send(1, '', { command: 'mode', mode: 'ai' });
            await send(2, 'PRIVATE-PROMPT');
            strict_1.default.equal(requests, 1);
            const record = records.find(r => r.message === 'OpenRouter request rejected');
            strict_1.default.ok(record);
            strict_1.default.equal(record.context.httpStatus, 403);
            strict_1.default.equal(record.context.destinationHost, '127.0.0.1');
            strict_1.default.equal(record.context.routing, 'reverse_proxy');
            strict_1.default.equal(record.context.model, 'test/model');
            strict_1.default.equal(record.context.failureCategory, 'geo_restriction');
            strict_1.default.equal(record.context.providerErrorCode, 403);
            strict_1.default.equal(record.context.upstreamRequestId, 'upstream-403');
            strict_1.default.equal(record.context.cloudflareRay, 'abcd1234-IAD');
            strict_1.default.equal(record.context.forwardProxyUsed, false);
            strict_1.default.match(record.context.openRouterRequestId, /^[a-f0-9-]+$/);
            const serialized = JSON.stringify(records);
            for (const forbidden of ['PRIVATE-PROMPT', 'PRIVATE-HISTORY', 'PRIVATE-RESPONSE', 'private-key', '/api/v1', 'Authorization'])
                strict_1.default.ok(!serialized.includes(forbidden));
            strict_1.default.match(replies.at(-1).message, /Не удалось/);
        }
        finally {
            await new Promise(resolve => server.close(() => resolve()));
        }
    });
    (0, node_test_1.it)('keeps HTML 403 responses operational and bounds oversized upstream bodies', async () => {
        const { UpstreamResponseError } = await import('../../packages/observability/dist/index.js');
        const records = [];
        const logger = { child() { return this; }, info(message, context) { records.push({ message, ...context }); }, exception() { } };
        let oversized = false;
        const server = http.createServer((req, res) => {
            if (oversized) {
                res.writeHead(200);
                res.end('x'.repeat(1048577));
            }
            else {
                res.writeHead(403, { 'Content-Type': 'text/html', 'x-request-id': 'unsafe header with PRIVATE-DATA' });
                res.end('<html>PRIVATE-DATA</html>');
            }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const client = new openrouter_js_1.OpenRouterClient({ apiKey: 'test', baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`, logger: logger });
            await strict_1.default.rejects(client.complete({ prompt: 'private' }), error => error instanceof UpstreamResponseError && error.statusCode === 403);
            strict_1.default.equal(records.at(-1).failureCategory, 'upstream_rejection');
            strict_1.default.equal(records.at(-1).responseFormat, 'non_json');
            strict_1.default.equal(records.at(-1).upstreamRequestId, undefined);
            oversized = true;
            await strict_1.default.rejects(client.complete({ prompt: 'private' }), error => error instanceof UpstreamResponseError && /size limit/.test(error.message));
            strict_1.default.ok(records.some(r => r.failureCategory === 'response_too_large'));
            strict_1.default.ok(!JSON.stringify(records).includes('PRIVATE-DATA'));
        }
        finally {
            await new Promise(resolve => server.close(() => resolve()));
        }
    });
});
//# sourceMappingURL=openrouter-role3.test.js.map