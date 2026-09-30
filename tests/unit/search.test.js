"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../../packages/jobs/dist/index.js");
const search_js_1 = require("../../apps/webhook/dist/search.js");
const handler_js_1 = require("../../apps/webhook/dist/handler.js");
const commands_js_1 = require("../../apps/webhook/dist/commands.js");
const results = Array.from({ length: 20 }, (_, i) => ({ title: `Title ${i}`, url: `https://example.org/${i}`, snippet: `Snippet ${i}` }));
(0, node_test_1.it)('parses Serper JSON, omits unsafe links, deduplicates and caps at 20', () => {
    const parsed = (0, search_js_1.parseSearchResults)({ organic: [{ link: 'http://127.0.0.1' }, ...results.concat(results).map(r => ({ title: r.title, link: r.url, snippet: r.snippet }))] });
    strict_1.default.deepEqual(parsed, results);
});
(0, node_test_1.it)('sends authenticated POST with 20 results and Russian language', async () => {
    const client = new search_js_1.SerperClient('test-key', async (url, options) => {
        strict_1.default.equal(url, 'https://google.serper.dev/search');
        strict_1.default.equal(options?.method, 'POST');
        strict_1.default.equal(options?.redirect, 'error');
        strict_1.default.equal((options?.headers)['X-API-KEY'], 'test-key');
        strict_1.default.deepEqual(JSON.parse(options?.body), { q: 'query', num: 20, hl: 'ru' });
        return Response.json({ organic: [{ title: 'Title', link: 'https://example.org', snippet: 'Text' }] });
    });
    strict_1.default.equal((await client.search('query')).length, 1);
});
(0, node_test_1.it)('rejects missing credentials, quota/auth failures and malformed responses; accepts empty organic results', async () => {
    await strict_1.default.rejects(new search_js_1.SerperClient('', async () => { strict_1.default.fail('must not request'); }).search('query'));
    for (const response of [new Response('private error', { status: 401 }), new Response('', { status: 429 }), new Response('<html>'), Response.json({ message: 'error' }), new Response('x'.repeat(1048577))]) {
        await strict_1.default.rejects(new search_js_1.SerperClient('test', async () => response).search('query'));
    }
    strict_1.default.deepEqual(await new search_js_1.SerperClient('test', async () => Response.json({ organic: [] })).search('query'), []);
});
(0, node_test_1.it)('atomically limits simultaneous requests, ignores duplicate events and allows next query after 30 seconds', async () => {
    const store = new index_js_1.MemorySearchStore();
    const now = Date.now();
    const make = (id, createdAt = now) => ({ id, ownerId: 1, peerId: 1, createdAt, query: 'query', status: 'pending', results: [] });
    const admissions = await Promise.all(Array.from({ length: 10 }, (_, i) => store.begin(make(String(i)))));
    strict_1.default.equal(admissions.filter(a => a.session).length, 1);
    strict_1.default.equal((await store.begin(make('0'))).duplicate, true);
    strict_1.default.ok((await store.begin(make('next', now + 30000))).session);
});
(0, node_test_1.it)('inline buttons dispatch exact read URL and more uses explicit offsets', () => {
    const page = (0, search_js_1.searchPage)({ id: 'id', ownerId: 1, peerId: 1, query: 'q', createdAt: Date.now(), status: 'completed', results }, 0);
    const rows = JSON.parse(page.keyboard).buttons;
    strict_1.default.ok(rows.length <= 6);
    const buttons = rows.flat();
    strict_1.default.equal(buttons.length, 8);
    strict_1.default.deepEqual((0, commands_js_1.parseCommand)('Title', buttons[0].action.payload), { type: 'read', url: results[0].url });
    strict_1.default.deepEqual((0, commands_js_1.parseCommand)('Ещё', buttons[7].action.payload), { type: 'more', searchId: 'id', offset: 7 });
    strict_1.default.equal(JSON.parse((0, search_js_1.searchPage)({ id: 'id', ownerId: 1, peerId: 1, query: 'q', createdAt: Date.now(), status: 'completed', results }, 14).keyboard).buttons.flat().length, 6);
});
(0, node_test_1.it)('search flow persists results, more bypasses limit, rejects cross-user cache access, and read creates a PDF job', async () => {
    const store = new index_js_1.MemoryJobStore();
    const searches = new index_js_1.MemorySearchStore();
    const replies = [];
    let calls = 0;
    const handler = new handler_js_1.WebhookHandler({ jobStore: store, searchStore: searches,
        outboxService: new index_js_1.OutboxService({ jobStore: store, queueClient: new index_js_1.MemoryQueueClient() }),
        searchClient: { search: async () => { calls++; return results; } }, vkClient: { sendMessage: async (p) => { replies.push(p); return 1; } },
        validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } });
    const send = async (id, text, payload, user = 42) => {
        await handler.handleRequest({ type: 'message_new', group_id: 1, event_id: `event-${user}-${id}`, object: { message: { id, peer_id: user, from_id: user, text, payload } } });
        await new Promise(r => setTimeout(r, 30));
    };
    await send(1, 'query');
    strict_1.default.equal(calls, 1);
    strict_1.default.ok(replies[0].message.includes('Привет!'));
    const keyboard = JSON.parse(replies[1].keyboard);
    const more = keyboard.buttons.flat()[7].action.payload;
    const id = JSON.parse(more).searchId;
    strict_1.default.equal((await searches.get(id))?.query, 'query');
    await send(1, 'query');
    strict_1.default.equal(calls, 1);
    await send(2, 'another query');
    strict_1.default.equal(calls, 1);
    strict_1.default.ok(replies.at(-1).message.includes('через'));
    await send(3, 'Ещё', more);
    strict_1.default.equal(calls, 1);
    strict_1.default.ok(replies.at(-1).message.startsWith('8.'));
    await send(4, 'Ещё', more, 43);
    strict_1.default.ok(replies.at(-1).message.includes('недоступна'));
    await send(5, 'read', keyboard.buttons.flat()[0].action.payload);
    strict_1.default.ok(replies.at(-1).message.includes('Готовим'));
});
(0, node_test_1.it)('YDB search admission uses one transaction for event deduplication, cooldown and query log', async () => {
    const queries = [];
    const store = new index_js_1.YdbSearchStore({ tableClient: { withSessionRetry: async (fn) => fn({ executeQuery: async (query, params, tx) => {
                    queries.push(query);
                    strict_1.default.ok(tx);
                    return { resultSets: [{ columns: [], rows: [] }, { columns: [], rows: [] }] };
                } }) } });
    strict_1.default.ok((await store.begin({ id: 'event', ownerId: 1, peerId: 1, query: 'q', createdAt: Date.now(), status: 'pending', results: [] })).session);
    strict_1.default.equal(queries.length, 1);
    strict_1.default.match(queries[0], /UPSERT INTO search_limits/);
    strict_1.default.match(queries[0], /NOT EXISTS/);
});
(0, node_test_1.it)('long and Unicode result URLs keep VK button payloads within 255 bytes', () => {
    const page = (0, search_js_1.searchPage)({ id: 'a'.repeat(64), ownerId: 1, peerId: 1, query: 'q', createdAt: Date.now(), status: 'completed',
        results: [{ title: 'Long URL', url: 'https://example.org/?q=' + 'я'.repeat(300), snippet: '' }] }, 0);
    const payload = JSON.parse(page.keyboard).buttons.flat()[0].action.payload;
    strict_1.default.ok(Buffer.byteLength(payload) <= 255);
    strict_1.default.equal((0, commands_js_1.parseCommand)('Long URL', payload).type, 'search-read');
});
//# sourceMappingURL=search.test.js.map