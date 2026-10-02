"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../../packages/jobs/dist/index.js");
const index_js_2 = require("../../packages/vk/dist/index.js");
const handler_js_1 = require("../../apps/webhook/dist/handler.js");
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
//# sourceMappingURL=chat-modes.test.js.map