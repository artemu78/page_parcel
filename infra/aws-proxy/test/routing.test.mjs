import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handler, PROXY_VERSION } from '../src/index.mjs';

function event(query = '') {
  return { rawPath: '/botFAKE/sendMessage', rawQueryString: query,
    requestContext: { http: { method: 'POST' } },
    headers: { host: 'proxy.example', 'content-type': 'application/json', authorization: 'Bearer fake' },
    body: '{"text":"Hello"}' };
}

for (const [query, origin] of [ ['', 'https://openrouter.ai'], ['destination=openrouter', 'https://openrouter.ai'], ['destination=telegram', 'https://api.telegram.org'] ]) {
  test(`routing ${query || 'default'}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, `${origin}/botFAKE/sendMessage`);
      assert.equal(options.method, 'POST');
      assert.equal(options.body, '{"text":"Hello"}');
      assert.equal(options.headers.host, undefined);
      assert.equal(options.headers.authorization, 'Bearer fake');
      assert.equal(options.redirect, 'error');
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    });
    assert.equal((await handler(event(query))).statusCode, 200);
  });
}

test('rejects unknown, empty and repeated selectors without fetching', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  for (const query of ['destination=', 'destination=https://evil.test', 'destination=telegram&destination=openrouter', 'destination=__proto__']) {
    assert.equal((await handler(event(query))).statusCode, 400);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('preserves other query values and pins upstream despite hostile path', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.telegram.org');
    assert.deepEqual(parsed.searchParams.getAll('x'), ['a+b', 'two']);
    assert.equal(parsed.searchParams.has('destination'), false);
    return new Response('ok', { headers: { 'content-type': 'text/plain' } });
  });
  const input = event('destination=telegram&x=a%2Bb&x=two');
  input.rawPath = '//evil.test/path';
  assert.equal((await handler(input)).statusCode, 200);
});

test('sanitizes thrown errors in response and logs', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('https://api.telegram.org/botSECRET/sendMessage private-body'); });
  const log = t.mock.method(console, 'error', () => {});
  const result = await handler(event('destination=telegram'));
  assert.equal(result.statusCode, 502);
  const output = JSON.stringify([result, log.mock.calls.map(call => call.arguments)]);
  assert.equal(output.includes('SECRET'), false);
  assert.equal(output.includes('private-body'), false);
});

test('preflight needs no upstream request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  const input = event('destination=telegram');
  input.requestContext.http.method = 'OPTIONS';
  assert.equal((await handler(input)).statusCode, 204);
  assert.equal(fetch.mock.callCount(), 0);
});


test('GET version returns the packaged version without an upstream request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  const packageVersion = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
  assert.equal(PROXY_VERSION, packageVersion);
  for (const query of ['version', 'version=1', 'destination=telegram&version']) {
    const input = event(query);
    input.requestContext.http.method = 'GET';
    const result = await handler(input);
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.deepEqual(JSON.parse(result.body), { service: 'aws-reverse-proxy', version: packageVersion });
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('POST version remains an upstream request', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new URL(url).searchParams.has('version'), true);
    return new Response('ok', { headers: { 'content-type': 'text/plain' } });
  });
  assert.equal((await handler(event('version'))).statusCode, 200);
});
