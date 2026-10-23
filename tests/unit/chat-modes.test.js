"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_crypto_1 = require("node:crypto");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../../packages/jobs/dist/index.js");
const index_js_2 = require("../../packages/vk/dist/index.js");
const handler_js_1 = require("../../apps/webhook/dist/handler.js");
const index_js_3 = require("../../packages/observability/dist/index.js");
const commands_js_1 = require("../../apps/webhook/dist/commands.js");
function setup(complete = async () => 'Hello', available = true) {
    const jobs = new index_js_1.MemoryJobStore();
    const conversations = new index_js_1.MemoryConversationStore();
    const replies = [];
    const prompts = [];
    let searches = 0;
    const options = { jobStore: jobs, conversationStore: conversations, searchStore: new index_js_1.MemorySearchStore(),
        outboxService: new index_js_1.OutboxService({ jobStore: jobs, queueClient: new index_js_1.MemoryQueueClient() }),
        vkClient: { sendMessage: async (p) => { replies.push(p); return 1; } },
        openRouterClient: available ? { complete: async (p) => { prompts.push(p); return complete(p); } } : undefined,
        searchClient: { search: async () => { searches++; return Array.from({ length: 10 }, (_, i) => ({ title: `Page ${i}`, url: `https://example.org/${i}`, snippet: '' })); } },
        validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } };
    let handler = new handler_js_1.WebhookHandler(options);
    const send = async (id, text, payload, user = 42) => {
        // Call the processing seam directly so completion assertions do not rely on timers.
        await handler.processMessageEvent({ type: 'message_new', group_id: 1, event_id: `event-${user}-${id}`,
            object: { message: { id, peer_id: user, from_id: user, text, payload: payload ? JSON.stringify(payload) : undefined } } });
    };
    return { jobs, conversations, replies, prompts, send, restart: () => { handler = new handler_js_1.WebhookHandler(options); }, searches: () => searches };
}
(0, node_test_1.it)('mode keyboard is persistent and marks the selected mode with color and text', () => {
    for (const mode of ['search', 'ai']) {
        const keyboard = JSON.parse((0, index_js_2.createModeKeyboard)(mode));
        strict_1.default.equal(keyboard.inline, false);
        strict_1.default.equal(keyboard.one_time, false);
        for (const button of keyboard.buttons[0]) {
            const command = (0, commands_js_1.parseCommand)(button.action.label, button.action.payload);
            strict_1.default.equal(command.type, 'mode');
            const active = JSON.parse(button.action.payload).mode === mode;
            strict_1.default.equal(button.color, active ? 'primary' : 'secondary');
            strict_1.default.equal(button.action.label.startsWith('✅'), active);
            strict_1.default.deepEqual((0, commands_js_1.parseCommand)(button.action.label), command);
        }
        strict_1.default.equal(keyboard.buttons.length, mode === 'ai' ? 2 : 1);
    }
    strict_1.default.equal((0, commands_js_1.parseCommand)('anything', JSON.stringify({ command: 'mode', mode: 'invalid' })).type, 'unrecognized');
});
(0, node_test_1.it)('defaults to search, persists explicit choice, preserves context across search, and resets via button', async () => {
    const f = setup();
    await f.jobs.setSetting('Model', 'custom/model');
    await f.send(1, 'find something');
    strict_1.default.equal(f.searches(), 1);
    strict_1.default.equal(f.prompts.length, 0);
    const searchReply = f.replies.at(-1);
    strict_1.default.match(searchReply.message, /^🔎 Результаты поиска/);
    const more = JSON.parse(JSON.parse(searchReply.keyboard).buttons.flat().at(-1).action.payload);
    await f.send(2, 'chat', { command: 'mode', mode: 'ai' });
    f.restart();
    await f.send(3, 'Hello');
    strict_1.default.equal(f.prompts[0].model, 'custom/model');
    strict_1.default.deepEqual(f.prompts[0].history, []);
    strict_1.default.match(f.replies.at(-1).message, /^💬 Ответ ИИ/);
    await f.send(4, 'search', { command: 'mode', mode: 'search' });
    await f.send(5, 'more', more);
    strict_1.default.equal(f.searches(), 1);
    strict_1.default.match(f.replies.at(-1).message, /8. Page 7/);
    await f.send(6, 'chat', { command: 'mode', mode: 'ai' });
    await f.send(7, 'Remember?');
    strict_1.default.deepEqual(f.prompts[1].history, [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello' }]);
    await f.send(8, 'new', { command: 'new-chat' });
    await f.send(9, 'Fresh');
    strict_1.default.deepEqual(f.prompts[2].history, []);
    strict_1.default.equal((await f.conversations.get(43)).mode, 'search');
});
(0, node_test_1.it)('deduplicates AI prompts and mode events without undoing a later switch', async () => {
    const f = setup();
    await f.send(1, '', { command: 'mode', mode: 'ai' });
    await Promise.all([f.send(2, 'Hello'), f.send(2, 'Hello')]);
    strict_1.default.equal(f.prompts.length, 1);
    await f.send(3, '', { command: 'mode', mode: 'search' });
    await f.send(1, '', { command: 'mode', mode: 'ai' });
    strict_1.default.equal((await f.conversations.get(42)).mode, 'search');
});
(0, node_test_1.it)('reset fences late completion and rejects overlapping prompts', async () => {
    let release;
    const f = setup(() => new Promise(resolve => { release = resolve; }));
    await f.send(1, '', { command: 'mode', mode: 'ai' });
    const first = f.send(2, 'First');
    while (!release)
        await new Promise(resolve => setImmediate(resolve));
    await f.send(3, 'Second');
    strict_1.default.equal(f.prompts.length, 1);
    strict_1.default.match(f.replies.at(-1).message, /Дождитесь/);
    await f.send(4, '', { command: 'new-chat' });
    release('Old reply');
    await first;
    strict_1.default.deepEqual((await f.conversations.get(42)).history, []);
    strict_1.default.ok(f.replies.every(r => !r.message.includes('Old reply')));
});
(0, node_test_1.it)('finishing AI after switching to search keeps the search selection', async () => {
    let release;
    const f = setup(() => new Promise(resolve => { release = resolve; }));
    await f.send(1, '', { command: 'mode', mode: 'ai' });
    const first = f.send(2, 'First');
    while (!release)
        await new Promise(resolve => setImmediate(resolve));
    await f.send(3, '', { command: 'mode', mode: 'search' });
    release('Reply');
    await first;
    strict_1.default.equal((await f.conversations.get(42)).mode, 'search');
    strict_1.default.match(JSON.parse(f.replies.at(-1).keyboard).buttons[0][0].action.label, /^✅/);
});
(0, node_test_1.it)('blocked users cannot switch, expired history is not sent, and provider failure releases reservation', async () => {
    const f = setup(async () => { throw new Error('test provider failure'); });
    await f.jobs.upsertUserAccess(42);
    await f.jobs.setUserStatus(42, 1);
    await f.send(1, '', { command: 'mode', mode: 'ai' });
    strict_1.default.equal((await f.conversations.get(42)).mode, 'search');
    await f.jobs.setUserStatus(42, 0);
    const state = await f.conversations.get(42);
    await f.conversations.compareAndSet(42, state.version, { ...state, mode: 'ai', historyUpdatedAt: Date.now() - index_js_1.HISTORY_TTL_MS - 1,
        history: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }] });
    await f.send(2, 'Hello');
    strict_1.default.deepEqual(f.prompts[0].history, []);
    strict_1.default.equal((await f.conversations.get(42)).pending, undefined);
    strict_1.default.match(f.replies.at(-1).message, /Не удалось/);
});
(0, node_test_1.it)('bounded history and compare-and-set prevent unbounded context and lost updates', async () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) }));
    const kept = (0, index_js_1.trimHistory)(history);
    strict_1.default.ok(kept.length <= 24);
    strict_1.default.ok(kept.reduce((n, m) => n + m.content.length, 0) <= 24000);
    strict_1.default.equal(kept[0].role, 'user');
    const store = new index_js_1.MemoryConversationStore();
    const state = await store.get(1);
    strict_1.default.deepEqual(await Promise.all([store.compareAndSet(1, 0, { ...state, mode: 'ai' }), store.compareAndSet(1, 0, state)]), [true, false]);
});
(0, node_test_1.it)('YDB conversation writes guard creation and update with a serializable version check', async () => {
    const store = new index_js_1.YdbConversationStore({ tableClient: { withSessionRetry: async (fn) => fn({ executeQuery: async (query, params, tx) => {
                    strict_1.default.ok(tx.beginTx.serializableReadWrite);
                    strict_1.default.equal(tx.commitTx, true);
                    strict_1.default.match(query, /COALESCE\(\(SELECT version FROM \$old\), 0\) = \$expected/);
                    strict_1.default.match(query, /FROM AS_TABLE/);
                    return { resultSets: [{ columns: [], rows: [] }] };
                } }) } });
    const state = await new index_js_1.MemoryConversationStore().get(1);
    strict_1.default.equal(await store.compareAndSet(1, 0, state), true);
    strict_1.default.equal(await store.compareAndSet(1, 1, state), false);
});
(0, node_test_1.it)('missing provider, long inputs and rate limits produce AI notices without searching', async () => {
    const unavailable = setup(undefined, false);
    await unavailable.send(1, '', { command: 'mode', mode: 'ai' });
    await unavailable.send(2, 'Hello');
    strict_1.default.match(unavailable.replies.at(-1).message, /временно недоступен/);
    strict_1.default.equal(unavailable.searches(), 0);
    const f = setup();
    await f.send(1, '', { command: 'mode', mode: 'ai' });
    await f.send(2, 'x'.repeat(4001));
    strict_1.default.equal(f.prompts.length, 0);
    for (let i = 0; i < 10; i++)
        await f.jobs.checkAndConsumeRateLimit(42, 10, 60000);
    await f.send(3, 'Hello');
    strict_1.default.equal(f.prompts.length, 0);
    strict_1.default.match(f.replies.at(-1).message, /Слишком много/);
    strict_1.default.equal((await f.conversations.get(42)).pending, undefined);
});
(0, node_test_1.it)('labels and splits long AI replies, and does not share another user context', async () => {
    const f = setup(async () => 'x'.repeat(9000));
    await f.send(1, '', { command: 'mode', mode: 'ai' });
    await f.send(2, 'Hello');
    const chunks = f.replies.filter(r => r.message.startsWith('💬 Ответ ИИ'));
    strict_1.default.equal(chunks.length, 3);
    strict_1.default.ok(chunks.every(r => r.message.length < 4000));
    await f.send(1, '', { command: 'mode', mode: 'ai' }, 43);
    await f.send(2, 'Other user', undefined, 43);
    strict_1.default.deepEqual(f.prompts.at(-1).history, []);
});
(0, node_test_1.it)('replayed free text cannot change provider after a mode switch', async () => {
    const f = setup();
    await f.send(1, 'Search query');
    await f.send(2, '', { command: 'mode', mode: 'ai' });
    await f.send(1, 'Search query');
    strict_1.default.equal(f.prompts.length, 0);
    await f.send(3, 'Chat prompt');
    strict_1.default.equal(f.prompts.length, 1);
    await f.send(4, '', { command: 'mode', mode: 'search' });
    await f.send(3, 'Chat prompt');
    strict_1.default.equal(f.searches(), 1);
});
(0, node_test_1.it)('passes database reverse-proxy and forward-proxy settings to the AI client', async () => {
    const f = setup();
    await f.jobs.setSetting('BaseUrl', 'https://example.org/aws/api/v1');
    await f.jobs.setSetting('Proxy', 'http://example.org:8080');
    await f.send(1, '', { command: 'mode', mode: 'ai' });
    await f.send(2, 'Hello');
    strict_1.default.equal(f.prompts[0].baseUrl, 'https://example.org/aws/api/v1');
    strict_1.default.equal(f.prompts[0].proxyUrl, 'http://example.org:8080');
});
(0, node_test_1.it)('owner can select verified models, persist selection, and restore the runtime default', async () => {
    const f = setup();
    const owner = 10487183;
    await f.jobs.setSetting('Model', 'custom/default');
    await f.jobs.setSetting('BaseUrl', 'https://example.org/api/v1');
    await f.jobs.setSetting('Proxy', '');
    await f.send(1, '/model', undefined, owner);
    const menu = JSON.parse(f.replies.at(-1).keyboard);
    strict_1.default.equal(menu.buttons.length, 3);
    await f.send(2, '', { command: 'model', model: 'sol-low' }, owner);
    f.restart();
    await f.send(3, 'Hello', undefined, owner);
    strict_1.default.equal(f.prompts[0].model, 'openai/gpt-6.1-sol');
    strict_1.default.equal(f.prompts[0].reasoningEffort, 'low');
    strict_1.default.equal(f.prompts[0].baseUrl, 'https://example.org/api/v1');
    strict_1.default.equal(f.prompts[0].proxyUrl, '');
    strict_1.default.match(f.replies.at(-1).keyboard, /Модель ИИ/);
    await f.send(4, '/model astra', undefined, owner);
    await f.send(2, '', { command: 'model', model: 'sol-low' }, owner);
    await f.send(5, 'Again', undefined, owner);
    strict_1.default.equal(f.prompts[1].model, 'openai/gpt-6-astra');
    strict_1.default.equal(f.prompts[1].reasoningEffort, undefined);
    strict_1.default.equal(f.prompts[1].history.length, 2);
    await f.send(6, '/model default', undefined, owner);
    await f.send(7, 'Default', undefined, owner);
    strict_1.default.equal(f.prompts[2].model, 'custom/default');
});
(0, node_test_1.it)('restricts models at commands and generation, including forged saved selections and global defaults', async () => {
    const f = setup();
    for (const text of ['/model', '/model sol-low', '/model astra'])
        await f.send(1, text);
    await f.send(2, '', { command: 'model', model: 'sol-low' });
    strict_1.default.equal((await f.conversations.get(42)).modelKey, undefined);
    strict_1.default.ok(f.replies.every(r => !r.keyboard.includes('Модель ИИ')));
    const state = await f.conversations.get(42);
    await f.conversations.compareAndSet(42, state.version, { ...state, mode: 'ai', modelKey: 'sol-low' });
    await f.jobs.setSetting('Model', 'openai/gpt-6-astra');
    await f.send(3, 'Hello');
    strict_1.default.equal(f.prompts[0].model, 'google/gemini-2.5-flash');
    strict_1.default.equal(f.prompts[0].reasoningEffort, undefined);
    await f.send(1, '/model arbitrary/provider', undefined, 10487183);
    strict_1.default.equal((await f.conversations.get(10487183)).modelKey, undefined);
});
(0, node_test_1.it)('model switching fences pending replies and blocked owners cannot select models', async () => {
    let release;
    const f = setup(() => new Promise(resolve => { release = resolve; }));
    const owner = 10487183;
    await f.send(1, '/model sol-low', undefined, owner);
    const pending = f.send(2, 'Hello', undefined, owner);
    while (!release)
        await new Promise(resolve => setImmediate(resolve));
    await f.send(3, '/model astra', undefined, owner);
    release('Stale response');
    await pending;
    strict_1.default.ok(f.replies.every(r => !r.message.includes('Stale response')));
    strict_1.default.equal((await f.conversations.get(owner)).modelKey, 'astra');
    await f.jobs.setUserStatus(owner, 1);
    await f.send(4, '/model sol-low', undefined, owner);
    strict_1.default.equal((await f.conversations.get(owner)).modelKey, 'astra');
});
(0, node_test_1.it)('AI upstream failures and empty completions post sanitized GitHub issues and notify the user', async () => {
    const posts = [];
    const reporter = new index_js_3.GitHubExceptionReporter({ token: 'token', repository: 'owner/repo', service: 'webhook',
        fetch: (async (_url, init) => {
            if (init?.method === 'POST') {
                posts.push(JSON.parse(String(init.body)));
                return new Response('{}', { status: 201 });
            }
            return new Response('[]');
        }) });
    (0, index_js_3.setExceptionReporter)(reporter);
    try {
        for (const complete of [async () => { throw new index_js_3.UpstreamResponseError('PRIVATE PROVIDER BODY', 'OpenRouter', 403); }, async () => '']) {
            const f = setup(complete);
            await f.send(1, '', { command: 'mode', mode: 'ai' });
            await f.send(2, 'PRIVATE USER PROMPT');
            await (0, index_js_3.flushExceptionReports)();
            strict_1.default.match(f.replies.at(-1).message, /Не удалось/);
            strict_1.default.equal((await f.conversations.get(42)).pending, undefined);
        }
        strict_1.default.equal(posts.length, 2);
        strict_1.default.ok(posts.every(p => p.title.includes('AI chat completion failed') && p.body.includes((0, node_crypto_1.createHash)('sha256').update('42:event-42-2').digest('hex'))));
        strict_1.default.doesNotMatch(JSON.stringify(posts), /PRIVATE PROVIDER BODY|PRIVATE USER PROMPT/);
    }
    finally {
        (0, index_js_3.setExceptionReporter)(undefined);
    }
});
(0, node_test_1.it)('public callback does not acknowledge while message processing is still detached', async () => {
    const f = setup();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const handler = new handler_js_1.WebhookHandler({ jobStore: f.jobs, conversationStore: f.conversations,
        outboxService: new index_js_1.OutboxService({ jobStore: f.jobs, queueClient: new index_js_1.MemoryQueueClient() }),
        vkClient: { sendMessage: async () => { await gate; return 1; } },
        validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } });
    let acknowledged = false;
    const pending = handler.handleRequest({ type: 'message_new', group_id: 1, event_id: 'lifecycle',
        object: { message: { id: 700, peer_id: 42, from_id: 42, text: '/version' } } }).then(result => { acknowledged = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    const early = acknowledged;
    release();
    await pending;
    strict_1.default.equal(early, false, 'callback returned before its message or error reporting finished');
});
(0, node_test_1.it)('queues AI before callback acknowledgment and worker alone generates and checkpoints the reply', async () => {
    const jobs = new index_js_1.MemoryJobStore();
    const conversations = new index_js_1.MemoryConversationStore();
    const queue = new index_js_1.MemoryQueueClient();
    const replies = [];
    const typing = [];
    let calls = 0;
    const options = { jobStore: jobs, conversationStore: conversations,
        outboxService: new index_js_1.OutboxService({ jobStore: jobs, queueClient: queue }),
        vkClient: { setTyping: async (peerId) => { typing.push(peerId); }, sendMessage: async (p) => { replies.push(p); return 1; } },
        openRouterClient: { complete: async () => { calls++; return 'Worker answer'; } },
        validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } };
    const webhook = new handler_js_1.WebhookHandler({ ...options, publishAiRequest: queue.publishAiRequest.bind(queue) });
    const callback = (id, text) => webhook.handleRequest({ type: 'message_new', group_id: 1,
        event_id: `queue-${id}`, object: { message: { id, peer_id: 42, from_id: 42, text } } });
    await callback(1, '💬 Чат с ИИ');
    await callback(2, 'PRIVATE QUEUED PROMPT');
    strict_1.default.equal(calls, 0);
    strict_1.default.equal(queue.aiMessages.length, 1);
    strict_1.default.deepEqual(typing, [42]);
    strict_1.default.ok(replies.every(r => !r.message.includes('Запрос принят')));
    strict_1.default.equal((await conversations.get(42)).lastAiRequest?.stage, 'queued');
    strict_1.default.doesNotMatch(JSON.stringify(queue.aiMessages), /PRIVATE QUEUED PROMPT/);
    await callback(2, 'PRIVATE QUEUED PROMPT'); // Crash/retry between reservation and queue publication can republish safely.
    const worker = new handler_js_1.WebhookHandler(options);
    await worker.processQueuedAiRequest(queue.aiMessages[0]);
    await worker.processQueuedAiRequest(queue.aiMessages[1]);
    strict_1.default.equal(calls, 1);
    strict_1.default.equal((await conversations.get(42)).pending, undefined);
    strict_1.default.equal((await conversations.get(42)).lastAiRequest?.stage, 'completed');
    strict_1.default.match(replies.at(-1).message, /Worker answer/);
    await callback(3, '/ai-status');
    strict_1.default.match(replies.at(-1).message, /ответ отправлен/);
    strict_1.default.doesNotMatch(replies.at(-1).message, /PRIVATE QUEUED PROMPT|Worker answer/);
});
(0, node_test_1.it)('public callback sends a fallback and flushes reporting even when database access fails', async () => {
    const jobs = new index_js_1.MemoryJobStore();
    jobs.getUser = async () => { throw new Error('Database unavailable'); };
    const replies = [];
    let flushed = false;
    let captured = 0;
    (0, index_js_3.setExceptionReporter)({ capture() { captured++; }, async flush() { flushed = true; } });
    try {
        const handler = new handler_js_1.WebhookHandler({ jobStore: jobs,
            conversationStore: { get: async () => { throw new Error('Conversation unavailable'); }, compareAndSet: async () => false },
            outboxService: new index_js_1.OutboxService({ jobStore: jobs, queueClient: new index_js_1.MemoryQueueClient() }),
            vkClient: { sendMessage: async (p) => { replies.push(p); return 1; } },
            validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } });
        const result = await handler.handleRequest({ type: 'message_new', group_id: 1, event_id: 'db-fail',
            object: { message: { id: 10, from_id: 42, peer_id: 42, text: 'PRIVATE PROMPT' } } });
        strict_1.default.equal(result.statusCode, 200);
        strict_1.default.equal(captured, 1);
        strict_1.default.equal(flushed, true);
        strict_1.default.match(replies.at(-1).message, /Не удалось обработать/);
    }
    finally {
        (0, index_js_3.setExceptionReporter)(undefined);
    }
});
(0, node_test_1.it)('failed queue publication notifies chat, reports failure and permits retry', async () => {
    const jobs = new index_js_1.MemoryJobStore();
    const conversations = new index_js_1.MemoryConversationStore();
    const replies = [];
    const state = await conversations.get(42);
    await conversations.compareAndSet(42, state.version, { ...state, mode: 'ai' });
    let calls = 0;
    const captures = [];
    (0, index_js_3.setExceptionReporter)({ capture(_e, operation) { captures.push(operation); }, async flush() { } });
    try {
        const handler = new handler_js_1.WebhookHandler({ jobStore: jobs, conversationStore: conversations,
            outboxService: new index_js_1.OutboxService({ jobStore: jobs, queueClient: new index_js_1.MemoryQueueClient() }),
            publishAiRequest: async () => { calls++; throw new Error('Queue unavailable'); },
            vkClient: { sendMessage: async (p) => { replies.push(p); return 1; } },
            validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } });
        const event = { type: 'message_new', group_id: 1, event_id: 'queue-failure', object: { message: { id: 1, from_id: 42, peer_id: 42, text: 'Hello' } } };
        await handler.handleRequest(event);
        await handler.handleRequest(event);
        strict_1.default.equal(calls, 2);
        strict_1.default.ok(captures.includes('Queue AI request'));
        strict_1.default.match(replies.at(-1).message, /Не удалось поставить/);
        strict_1.default.equal((await conversations.get(42)).lastAiRequest?.stage, 'failed');
        strict_1.default.equal((await conversations.get(42)).pending, undefined);
    }
    finally {
        (0, index_js_3.setExceptionReporter)(undefined);
    }
});
(0, node_test_1.it)('expired queued attempts report interruption and tell the owner without calling the provider', async () => {
    const jobs = new index_js_1.MemoryJobStore();
    const conversations = new index_js_1.MemoryConversationStore();
    const replies = [];
    const eventId = 'a'.repeat(64);
    const state = await conversations.get(42);
    await conversations.compareAndSet(42, 0, { ...state, mode: 'ai', pending: { eventId, expiresAt: 1, prompt: 'PRIVATE', stage: 'processing' } });
    const captures = [];
    (0, index_js_3.setExceptionReporter)({ capture(_e, operation) { captures.push(operation); }, async flush() { } });
    try {
        const worker = new handler_js_1.WebhookHandler({ jobStore: jobs, conversationStore: conversations,
            outboxService: new index_js_1.OutboxService({ jobStore: jobs, queueClient: new index_js_1.MemoryQueueClient() }),
            openRouterClient: { complete: async () => { throw new Error('Provider must not run'); } },
            vkClient: { sendMessage: async (p) => { replies.push(p); return 1; } },
            validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } });
        strict_1.default.equal((await worker.processQueuedAiRequest({ kind: 'ai', ownerId: 42, eventId })).retryable, false);
        strict_1.default.ok(captures.includes('AI request interrupted'));
        strict_1.default.match(replies.at(-1).message, /прервана/);
        strict_1.default.equal((await conversations.get(42)).lastAiRequest?.stage, 'interrupted');
        strict_1.default.equal((await conversations.get(42)).pending, undefined);
    }
    finally {
        (0, index_js_3.setExceptionReporter)(undefined);
    }
});
(0, node_test_1.it)('worker provider failures leave failed status and report, while a reset fences queued prompts', async () => {
    const jobs = new index_js_1.MemoryJobStore();
    const conversations = new index_js_1.MemoryConversationStore();
    const queue = new index_js_1.MemoryQueueClient();
    const replies = [];
    const captures = [];
    const options = { jobStore: jobs, conversationStore: conversations,
        outboxService: new index_js_1.OutboxService({ jobStore: jobs, queueClient: queue }),
        vkClient: { sendMessage: async (p) => { replies.push(p); return 1; } },
        validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } };
    const webhook = new handler_js_1.WebhookHandler({ ...options, publishAiRequest: queue.publishAiRequest.bind(queue) });
    let calls = 0;
    const worker = new handler_js_1.WebhookHandler({ ...options, openRouterClient: { complete: async () => { calls++; throw new index_js_3.UpstreamResponseError('PRIVATE', 'OpenRouter', 403); } } });
    const send = (id, text) => webhook.handleRequest({ type: 'message_new', group_id: 1, event_id: `failure-${id}`,
        object: { message: { id, peer_id: 42, from_id: 42, text } } });
    (0, index_js_3.setExceptionReporter)({ capture(error, operation) { captures.push({ error, operation }); }, async flush() { } });
    try {
        await send(1, '💬 Чат с ИИ');
        await send(2, 'Hello');
        await worker.processQueuedAiRequest(queue.aiMessages[0]);
        strict_1.default.match(replies.at(-1).message, /Не удалось/);
        strict_1.default.equal((await conversations.get(42)).lastAiRequest?.stage, 'failed');
        strict_1.default.ok(captures.some(c => c.operation === 'AI chat completion failed'));
        await send(30, '/ai-status');
        strict_1.default.match(replies.at(-1).message, /provider_failure/);
        strict_1.default.match(replies.at(-1).message, /HTTP: 403/);
        await send(3, 'Another');
        await send(4, 'Новый разговор');
        await worker.processQueuedAiRequest(queue.aiMessages[1]);
        strict_1.default.equal(calls, 1);
        strict_1.default.equal((await conversations.get(42)).pending, undefined);
    }
    finally {
        (0, index_js_3.setExceptionReporter)(undefined);
    }
});
(0, node_test_1.it)('renews typing during generation, reports typing failures without aborting and stops before the answer', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const jobs = new index_js_1.MemoryJobStore();
    const conversations = new index_js_1.MemoryConversationStore();
    const replies = [];
    const state = await conversations.get(42);
    await conversations.compareAndSet(42, 0, { ...state, mode: 'ai' });
    let typingCalls = 0;
    let release;
    const captures = [];
    (0, index_js_3.setExceptionReporter)({ capture(_e, operation) { captures.push(operation); }, async flush() { } });
    try {
        const handler = new handler_js_1.WebhookHandler({ jobStore: jobs, conversationStore: conversations,
            outboxService: new index_js_1.OutboxService({ jobStore: jobs, queueClient: new index_js_1.MemoryQueueClient() }),
            vkClient: { setTyping: async () => { typingCalls++; if (typingCalls === 1)
                    throw new index_js_3.UpstreamResponseError('Forbidden', 'VK', 403); },
                sendMessage: async (p) => { replies.push(p); return 1; } },
            openRouterClient: { complete: () => new Promise(resolve => { release = resolve; }) },
            validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } });
        const processing = handler.processMessageEvent({ type: 'message_new', group_id: 1, event_id: 'typing-renewal',
            object: { message: { id: 1, from_id: 42, peer_id: 42, text: 'Hello' } } });
        while (!release)
            await new Promise(resolve => setImmediate(resolve));
        strict_1.default.equal(typingCalls, 1);
        strict_1.default.ok(captures.includes('Set VK typing activity'));
        t.mock.timers.tick(7000);
        await new Promise(resolve => setImmediate(resolve));
        strict_1.default.equal(typingCalls, 2);
        release('Answer');
        await processing;
        strict_1.default.match(replies.at(-1).message, /Answer/);
        t.mock.timers.tick(21000);
        await new Promise(resolve => setImmediate(resolve));
        strict_1.default.equal(typingCalls, 2);
        strict_1.default.equal((await conversations.get(42)).lastAiRequest?.stage, 'completed');
    }
    finally {
        t.mock.timers.reset();
        (0, index_js_3.setExceptionReporter)(undefined);
    }
});
//# sourceMappingURL=chat-modes.test.js.map