import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VkApiClient } from '../../packages/vk/dist/index.js';
import { UpstreamResponseError } from '../../packages/observability/dist/index.js';

test('typing uses messages.setActivity and the community token without sending a message', async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; params: URLSearchParams }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), params: new URLSearchParams(String(init?.body)) });
    return new Response(JSON.stringify({ response: 1 }));
  }) as typeof fetch;
  try {
    const client = new VkApiClient({ token: 'test-community-token' });
    await client.setTyping(42);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.vk.com/method/messages.setActivity');
    assert.deepEqual(Object.fromEntries(requests[0].params), {
      peer_id: '42', type: 'typing', v: '5.199', access_token: 'test-community-token'
    });
    globalThis.fetch = (async () => new Response('{}', { status: 403 })) as typeof fetch;
    await assert.rejects(client.setTyping(42), error => error instanceof UpstreamResponseError && error.statusCode === 403);
  } finally { globalThis.fetch = original; }
});
