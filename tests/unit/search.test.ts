import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySearchStore, MemoryJobStore, MemoryQueueClient, OutboxService, YdbSearchStore } from '../../packages/jobs/dist/index.js';
import { parseSearchResults, SerperClient, searchPage } from '../../apps/webhook/dist/search.js';
import { WebhookHandler } from '../../apps/webhook/dist/handler.js';
import { parseCommand } from '../../apps/webhook/dist/commands.js';

const results = Array.from({ length: 20 }, (_, i) => ({ title: `Title ${i}`, url: `https://example.org/${i}`, snippet: `Snippet ${i}` }));
it('parses Serper JSON, omits unsafe links, deduplicates and caps at 20', () => {
  const parsed = parseSearchResults({ organic: [{ link: 'http://127.0.0.1' }, ...results.concat(results).map(r => ({ title: r.title, link: r.url, snippet: r.snippet }))] });
  assert.deepEqual(parsed, results);
});
it('sends authenticated POST with 20 results and Russian language', async () => {
  const client = new SerperClient('test-key', async (url, options) => {
    assert.equal(url, 'https://google.serper.dev/search');
    assert.equal(options?.method, 'POST'); assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>)['X-API-KEY'], 'test-key');
    assert.deepEqual(JSON.parse(options?.body as string), { q: 'query', num: 20, hl: 'ru' });
    return Response.json({ organic: [{ title: 'Title', link: 'https://example.org', snippet: 'Text' }] });
  });
  assert.equal((await client.search('query')).length, 1);
});
it('rejects missing credentials, quota/auth failures and malformed responses; accepts empty organic results', async () => {
  await assert.rejects(new SerperClient('', async () => { assert.fail('must not request'); }).search('query'));
  for (const response of [new Response('private error', { status: 401 }), new Response('', { status: 429 }), new Response('<html>'), Response.json({ message: 'error' }), new Response('x'.repeat(1048577))]) {
    await assert.rejects(new SerperClient('test', async () => response).search('query'));
  }
  assert.deepEqual(await new SerperClient('test', async () => Response.json({ organic: [] })).search('query'), []);
});
it('atomically limits simultaneous requests, ignores duplicate events and allows next query after 30 seconds', async () => {
  const store = new MemorySearchStore(); const now = Date.now();
  const make = (id: string, createdAt = now) => ({ id, ownerId: 1, peerId: 1, createdAt, query: 'query', status: 'pending' as const, results: [] });
  const admissions = await Promise.all(Array.from({ length: 10 }, (_, i) => store.begin(make(String(i)))));
  assert.equal(admissions.filter(a => a.session).length, 1);
  assert.equal((await store.begin(make('0'))).duplicate, true);
  assert.ok((await store.begin(make('next', now + 30000))).session);
});
it('inline buttons dispatch exact read URL and more uses explicit offsets', () => {
  const page = searchPage({ id: 'id', ownerId: 1, peerId: 1, query: 'q', createdAt: Date.now(), status: 'completed', results }, 0);
  const rows = JSON.parse(page.keyboard).buttons;
  assert.ok(rows.length <= 6);
  const buttons = rows.flat();
  assert.equal(buttons.length, 8);
  assert.deepEqual(parseCommand('Title', buttons[0].action.payload), { type: 'read', url: results[0].url });
  assert.deepEqual(parseCommand('Ещё', buttons[7].action.payload), { type: 'more', searchId: 'id', offset: 7 });
  assert.equal(JSON.parse(searchPage({ id: 'id', ownerId: 1, peerId: 1, query: 'q', createdAt: Date.now(), status: 'completed', results }, 14).keyboard).buttons.flat().length, 6);
});
it('search flow persists results, more bypasses limit, rejects cross-user cache access, and read creates a PDF job', async () => {
  const store = new MemoryJobStore(); const searches = new MemorySearchStore();
  const replies: any[] = []; let calls = 0;
  const handler = new WebhookHandler({ jobStore: store, searchStore: searches,
    outboxService: new OutboxService({ jobStore: store, queueClient: new MemoryQueueClient() }),
    searchClient: { search: async () => { calls++; return results; } }, vkClient: { sendMessage: async (p: any) => { replies.push(p); return 1; } } as any,
    validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } });
  const send = async (id: number, text: string, payload?: string, user = 42) => {
    await handler.handleRequest({ type: 'message_new', group_id: 1, event_id: `event-${user}-${id}`, object: { message: { id, peer_id: user, from_id: user, text, payload } } });
    await new Promise(r => setTimeout(r, 30));
  };
  await send(1, 'query'); assert.equal(calls, 1);
  assert.ok(replies[0].message.includes('Привет!'));
  const keyboard = JSON.parse(replies[1].keyboard);
  const more = keyboard.buttons.flat()[7].action.payload;
  const id = JSON.parse(more).searchId;
  assert.equal((await searches.get(id))?.query, 'query');
  await send(1, 'query'); assert.equal(calls, 1);
  await send(2, 'another query'); assert.equal(calls, 1); assert.ok(replies.at(-1).message.includes('через'));
  await send(3, 'Ещё', more); assert.equal(calls, 1); assert.ok(replies.at(-1).message.startsWith('8.'));
  await send(4, 'Ещё', more, 43); assert.ok(replies.at(-1).message.includes('недоступна'));
  await send(5, 'read', keyboard.buttons.flat()[0].action.payload); assert.ok(replies.at(-1).message.includes('Готовим'));
});
it('YDB search admission uses one transaction for event deduplication, cooldown and query log', async () => {
  const queries: string[] = [];
  const store = new YdbSearchStore({ tableClient: { withSessionRetry: async (fn: any) => fn({ executeQuery: async (query: string, params: any, tx: any) => {
    queries.push(query); assert.ok(tx); return { resultSets: [{ columns: [], rows: [] }, { columns: [], rows: [] }] };
  } }) } } as any);
  assert.ok((await store.begin({ id: 'event', ownerId: 1, peerId: 1, query: 'q', createdAt: Date.now(), status: 'pending', results: [] })).session);
  assert.equal(queries.length, 1); assert.match(queries[0], /UPSERT INTO search_limits/); assert.match(queries[0], /NOT EXISTS/);
});

it('long and Unicode result URLs keep VK button payloads within 255 bytes', () => {
  const page = searchPage({ id: 'a'.repeat(64), ownerId: 1, peerId: 1, query: 'q', createdAt: Date.now(), status: 'completed',
    results: [{ title: 'Long URL', url: 'https://example.org/?q=' + 'я'.repeat(300), snippet: '' }] }, 0);
  const payload = JSON.parse(page.keyboard).buttons.flat()[0].action.payload;
  assert.ok(Buffer.byteLength(payload) <= 255);
  assert.equal(parseCommand('Long URL', payload).type, 'search-read');
});
