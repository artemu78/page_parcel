import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySearchStore, MemoryConversationStore, MemoryJobStore, MemoryQueueClient, OutboxService, HISTORY_TTL_MS, trimHistory, YdbConversationStore } from '../../packages/jobs/dist/index.js';
import { createModeKeyboard } from '../../packages/vk/dist/index.js';
import { WebhookHandler } from '../../apps/webhook/dist/handler.js';
import { parseCommand } from '../../apps/webhook/dist/commands.js';

function setup(complete: (params: any) => Promise<string> = async () => 'Hello', available = true) {
  const jobs = new MemoryJobStore();
  const conversations = new MemoryConversationStore();
  const replies: any[] = []; const prompts: any[] = []; let searches = 0;
  const options = { jobStore: jobs, conversationStore: conversations, searchStore: new MemorySearchStore(),
    outboxService: new OutboxService({ jobStore: jobs, queueClient: new MemoryQueueClient() }),
    vkClient: { sendMessage: async (p: any) => { replies.push(p); return 1; } } as any,
    openRouterClient: available ? { complete: async (p: any) => { prompts.push(p); return complete(p); } } as any : undefined,
    searchClient: { search: async () => { searches++; return Array.from({ length: 10 }, (_, i) => ({ title: `Page ${i}`, url: `https://example.org/${i}`, snippet: '' })); } },
    validationOptions: { expectedGroupId: 1, confirmationCode: 'ok' } };
  let handler = new WebhookHandler(options);
  const send = async (id: number, text: string, payload?: object, user = 42) => {
    // Call the processing seam directly so completion assertions do not rely on timers.
    await (handler as any).processMessageEvent({ type: 'message_new', group_id: 1, event_id: `event-${user}-${id}`,
      object: { message: { id, peer_id: user, from_id: user, text, payload: payload ? JSON.stringify(payload) : undefined } } });
  };
  return { jobs, conversations, replies, prompts, send, restart: () => { handler = new WebhookHandler(options); }, searches: () => searches };
}

it('mode keyboard is persistent and marks the selected mode with color and text', () => {
  for (const mode of ['search', 'ai'] as const) {
    const keyboard = JSON.parse(createModeKeyboard(mode));
    assert.equal(keyboard.inline, false); assert.equal(keyboard.one_time, false);
    for (const button of keyboard.buttons[0]) {
      const command = parseCommand(button.action.label, button.action.payload);
      assert.equal(command.type, 'mode');
      const active = JSON.parse(button.action.payload).mode === mode;
      assert.equal(button.color, active ? 'primary' : 'secondary');
      assert.equal(button.action.label.startsWith('✅'), active);
      assert.deepEqual(parseCommand(button.action.label), command);
    }
    assert.equal(keyboard.buttons.length, mode === 'ai' ? 2 : 1);
  }
  assert.equal(parseCommand('anything', JSON.stringify({ command: 'mode', mode: 'invalid' })).type, 'unrecognized');
});

it('defaults to search, persists explicit choice, preserves context across search, and resets via button', async () => {
  const f = setup(); await f.jobs.setSetting('Model', 'custom/model');
  await f.send(1, 'find something'); assert.equal(f.searches(), 1); assert.equal(f.prompts.length, 0);
  const searchReply = f.replies.at(-1); assert.match(searchReply.message, /^🔎 Результаты поиска/);
  const more = JSON.parse(JSON.parse(searchReply.keyboard).buttons.flat().at(-1).action.payload);
  await f.send(2, 'chat', { command: 'mode', mode: 'ai' });
  f.restart();
  await f.send(3, 'Hello'); assert.equal(f.prompts[0].model, 'custom/model'); assert.deepEqual(f.prompts[0].history, []);
  assert.match(f.replies.at(-1).message, /^💬 Ответ ИИ/);
  await f.send(4, 'search', { command: 'mode', mode: 'search' });
  await f.send(5, 'more', more); assert.equal(f.searches(), 1); assert.match(f.replies.at(-1).message, /8. Page 7/);
  await f.send(6, 'chat', { command: 'mode', mode: 'ai' });
  await f.send(7, 'Remember?'); assert.deepEqual(f.prompts[1].history, [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello' }]);
  await f.send(8, 'new', { command: 'new-chat' });
  await f.send(9, 'Fresh'); assert.deepEqual(f.prompts[2].history, []);
  assert.equal((await f.conversations.get(43)).mode, 'search');
});

it('deduplicates AI prompts and mode events without undoing a later switch', async () => {
  const f = setup();
  await f.send(1, '', { command: 'mode', mode: 'ai' });
  await Promise.all([f.send(2, 'Hello'), f.send(2, 'Hello')]); assert.equal(f.prompts.length, 1);
  await f.send(3, '', { command: 'mode', mode: 'search' });
  await f.send(1, '', { command: 'mode', mode: 'ai' });
  assert.equal((await f.conversations.get(42)).mode, 'search');
});

it('reset fences late completion and rejects overlapping prompts', async () => {
  let release!: (value: string) => void;
  const f = setup(() => new Promise(resolve => { release = resolve; }));
  await f.send(1, '', { command: 'mode', mode: 'ai' });
  const first = f.send(2, 'First');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await f.send(3, 'Second'); assert.equal(f.prompts.length, 1); assert.match(f.replies.at(-1).message, /Дождитесь/);
  await f.send(4, '', { command: 'new-chat' });
  release('Old reply'); await first;
  assert.deepEqual((await f.conversations.get(42)).history, []);
  assert.ok(f.replies.every(r => !r.message.includes('Old reply')));
});

it('finishing AI after switching to search keeps the search selection', async () => {
  let release!: (value: string) => void;
  const f = setup(() => new Promise(resolve => { release = resolve; }));
  await f.send(1, '', { command: 'mode', mode: 'ai' });
  const first = f.send(2, 'First');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await f.send(3, '', { command: 'mode', mode: 'search' });
  release('Reply'); await first;
  assert.equal((await f.conversations.get(42)).mode, 'search');
  assert.match(JSON.parse(f.replies.at(-1).keyboard).buttons[0][0].action.label, /^✅/);
});

it('blocked users cannot switch, expired history is not sent, and provider failure releases reservation', async () => {
  const f = setup(async () => { throw new Error('test provider failure'); });
  await f.jobs.upsertUserAccess(42); await f.jobs.setUserStatus(42, 1);
  await f.send(1, '', { command: 'mode', mode: 'ai' }); assert.equal((await f.conversations.get(42)).mode, 'search');
  await f.jobs.setUserStatus(42, 0);
  const state = await f.conversations.get(42);
  await f.conversations.compareAndSet(42, state.version, { ...state, mode: 'ai', historyUpdatedAt: Date.now() - HISTORY_TTL_MS - 1,
    history: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }] });
  await f.send(2, 'Hello'); assert.deepEqual(f.prompts[0].history, []);
  assert.equal((await f.conversations.get(42)).pending, undefined);
  assert.match(f.replies.at(-1).message, /Не удалось/);
});

it('bounded history and compare-and-set prevent unbounded context and lost updates', async () => {
  const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: 'x'.repeat(2000) }));
  const kept = trimHistory(history); assert.ok(kept.length <= 24); assert.ok(kept.reduce((n, m) => n + m.content.length, 0) <= 24000);
  assert.equal(kept[0].role, 'user');
  const store = new MemoryConversationStore(); const state = await store.get(1);
  assert.deepEqual(await Promise.all([store.compareAndSet(1, 0, { ...state, mode: 'ai' }), store.compareAndSet(1, 0, state)]), [true, false]);
});

it('YDB conversation writes guard creation and update with a serializable version check', async () => {
  const store = new YdbConversationStore({ tableClient: { withSessionRetry: async (fn: any) => fn({ executeQuery: async (query: string, params: any, tx: any) => {
    assert.ok(tx.beginTx.serializableReadWrite); assert.equal(tx.commitTx, true);
    assert.match(query, /COALESCE\(\(SELECT version FROM \$old\), 0\) = \$expected/);
    assert.match(query, /FROM AS_TABLE/);
    return { resultSets: [{ columns: [], rows: [] }] };
  } }) } } as any);
  const state = await new MemoryConversationStore().get(1);
  assert.equal(await store.compareAndSet(1, 0, state), true);
  assert.equal(await store.compareAndSet(1, 1, state), false);
});


it('missing provider, long inputs and rate limits produce AI notices without searching', async () => {
  const unavailable = setup(undefined, false);
  await unavailable.send(1, '', { command: 'mode', mode: 'ai' });
  await unavailable.send(2, 'Hello');
  assert.match(unavailable.replies.at(-1).message, /временно недоступен/);
  assert.equal(unavailable.searches(), 0);
  const f = setup();
  await f.send(1, '', { command: 'mode', mode: 'ai' });
  await f.send(2, 'x'.repeat(4001)); assert.equal(f.prompts.length, 0);
  for (let i = 0; i < 10; i++) await f.jobs.checkAndConsumeRateLimit(42, 10, 60000);
  await f.send(3, 'Hello'); assert.equal(f.prompts.length, 0);
  assert.match(f.replies.at(-1).message, /Слишком много/);
  assert.equal((await f.conversations.get(42)).pending, undefined);
});

it('labels and splits long AI replies, and does not share another user context', async () => {
  const f = setup(async () => 'x'.repeat(9000));
  await f.send(1, '', { command: 'mode', mode: 'ai' });
  await f.send(2, 'Hello');
  const chunks = f.replies.filter(r => r.message.startsWith('💬 Ответ ИИ'));
  assert.equal(chunks.length, 3); assert.ok(chunks.every(r => r.message.length < 4000));
  await f.send(1, '', { command: 'mode', mode: 'ai' }, 43);
  await f.send(2, 'Other user', undefined, 43);
  assert.deepEqual(f.prompts.at(-1).history, []);
});

it('replayed free text cannot change provider after a mode switch', async () => {
  const f = setup();
  await f.send(1, 'Search query');
  await f.send(2, '', { command: 'mode', mode: 'ai' });
  await f.send(1, 'Search query'); assert.equal(f.prompts.length, 0);
  await f.send(3, 'Chat prompt'); assert.equal(f.prompts.length, 1);
  await f.send(4, '', { command: 'mode', mode: 'search' });
  await f.send(3, 'Chat prompt'); assert.equal(f.searches(), 1);
});
