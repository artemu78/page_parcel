import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubExceptionReporter, Logger, UpstreamResponseError, setExceptionReporter, buildExceptionReport, redactSensitiveData } from '../../packages/observability/dist/index.js';
import type { ExceptionReport, ExceptionOutbox } from '../../packages/observability/dist/index.js';

class Outbox implements ExceptionOutbox {
  reports = new Map<string, ExceptionReport>();
  async save(report: ExceptionReport) { this.reports.set(report.id, report); }
  async pending() { return [...this.reports.values()]; }
  async remove(id: string) { this.reports.delete(id); }
}

test('exceptions create bug issues, retain code location, exclude private values and deduplicate propagation', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const reporter = new GitHubExceptionReporter({
    token: 'private-token', repository: 'owner/repo',
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });
      return init?.method === 'POST' ? new Response('{}', { status: 201 }) : new Response('[]');
    }) as typeof fetch
  });
  const error = new TypeError('prompt=private user text; ghp_privatekey; https://private.test?q=secret');
  error.stack = 'TypeError: private\n    at run (/secret/home/app.ts:42:3)\n    at https://private.test/?key=secret';
  reporter.capture(error, 'Process job', { service: 'worker', jobId: 'job_1', prompt: 'private', ownerId: 123 });
  reporter.capture(error, 'Parent catch', {});
  await reporter.flush();
  const posts = calls.filter(call => call.init?.method === 'POST');
  assert.equal(posts.length, 1);
  const payload = JSON.parse(String(posts[0].init?.body));
  assert.deepEqual(payload.labels, ['bug']);
  assert.match(payload.body, /app.ts:42:3/);
  assert.doesNotMatch(payload.body, /private user text|ghp_privatekey|secret\/home|private.test|ownerId/);
  assert.equal((posts[0].init?.headers as Record<string, string>).Authorization, 'Bearer private-token');
});

test('durable reports survive reporter restart and GitHub failure without recursive reports', async () => {
  const outbox = new Outbox();
  let failures = 0;
  const first = new GitHubExceptionReporter({ token: 'token', repository: 'owner/repo', outbox,
    fetch: (async () => new Response('{}', { status: 503 })) as typeof fetch,
    onFailure: () => failures++ });
  first.capture(new Error('boom'), 'Process job', {});
  await first.flush();
  assert.equal(outbox.reports.size, 1);
  assert.equal(failures, 1);
  const second = new GitHubExceptionReporter({ token: 'token', repository: 'owner/repo', outbox,
    fetch: (async (_url, init) => init?.method === 'POST' ? new Response('{}', { status: 201 }) : new Response('[]')) as typeof fetch });
  await second.flush();
  assert.equal(outbox.reports.size, 0);
});

test('ambiguous POST success is recovered through issue marker, without another POST', async () => {
  const outbox = new Outbox();
  let remoteIssue: { body: string } | undefined;
  let posts = 0;
  const reporter = new GitHubExceptionReporter({ token: 'token', repository: 'owner/repo', outbox,
    fetch: (async (_url, init) => {
      if (init?.method === 'POST') {
        posts++;
        remoteIssue = JSON.parse(String(init.body));
        throw new Error('Connection closed after creation');
      }
      return new Response(JSON.stringify(remoteIssue ? [remoteIssue] : []));
    }) as typeof fetch });
  reporter.capture(new Error('boom'), 'Render', {});
  await reporter.flush();
  assert.equal(outbox.reports.size, 1);
  await reporter.flush();
  assert.equal(posts, 1);
  assert.equal(outbox.reports.size, 0);
});

test('upstream response and SDK HTTP failures stay Info, code errors report despite log threshold', async () => {
  const captures: unknown[] = [];
  setExceptionReporter({ capture: error => { captures.push(error); }, flush: async () => {} });
  try {
    const logger = new Logger('error').child({ service: 'webhook' });
    logger.exception(new UpstreamResponseError('HTTP 429', 'OpenRouter', 429), 'Complete request');
    logger.exception(Object.assign(new Error('HTTP 500'), { $metadata: { httpStatusCode: 500 } }), 'Publish queue');
    const codeError = new TypeError('bad state');
    logger.exception(codeError, 'Handle event');
    assert.deepEqual(captures, [codeError]);
  } finally { setExceptionReporter(undefined); }
});

test('report body ignores attacker-controlled error properties and context', () => {
  const error = new Error('private');
  error.name = 'ghp_secret';
  error.stack = 'Error: private\n    at secret_TOKEN (/tmp/app.ts:12:5)\n    at ghp_secret';
  const report = buildExceptionReport(error, 'Read settings', { service: 'worker', article: 'private', url: 'private' });
  assert.doesNotMatch(JSON.stringify(report), /ghp_secret|secret_TOKEN|"article"|"url"/);
  assert.match(report.body, /app.ts:12:5/);
  assert.equal(redactSensitiveData('ghp_abcdef sk-or-v1-abcdefgh'), '[REDACTED] [REDACTED]');
});

test('received failure responses emit Info at the enclosing exception boundary', () => {
  class RecordingLogger extends Logger {
    levels: string[] = [];
    override info() { this.levels.push('info'); }
    override error() { this.levels.push('error'); }
  }
  const logger = new RecordingLogger();
  logger.exception(new UpstreamResponseError('HTTP 403', 'Article', 403), 'Process job');
  logger.exception(Object.assign(new Error('SDK response'), { $metadata: { httpStatusCode: 503 } }), 'Publish job');
  assert.deepEqual(logger.levels, ['info', 'info']);
});

test('uncaught exceptions and unhandled rejections report and flush before process exit', async () => {
  const { spawnSync } = await import('node:child_process');
  const moduleUrl = pathToFileURL(resolve('packages/observability/dist/index.js')).href;
  for (const [trigger, operation] of [
    ["setTimeout(() => { throw new TypeError('boom'); }, 0);", 'Uncaught exception'],
    ["Promise.reject(new Error('boom'));", 'Unhandled rejection']
  ]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { setExceptionReporter, installRuntimeExceptionHandlers } from ${JSON.stringify(moduleUrl)};
      setExceptionReporter({ capture(_error, operation) { console.log('capture:' + operation); },
        async flush() { console.log('flushed'); } });
      installRuntimeExceptionHandlers('test');
      ${trigger}
    `], { encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stdout, new RegExp(`capture:${operation}`));
    assert.match(child.stdout, /flushed/);
  }
});

test('persistent outbox startup tolerates an existing table and concurrent creation, but rejects permission failures', async () => {
  const { YdbExceptionOutbox } = await import('../../packages/jobs/dist/index.js');
  const { StatusCode } = await import('ydb-sdk');
  const sdkError = (status: number) => new (class extends Error { static status = status; })();
  let creates = 0;
  let describes = 0;
  const session = {
    async describeTable() { describes++; },
    async createTable() { creates++; }
  };
  const driver = { tableClient: { withSession: async (fn: (s: typeof session) => unknown) => fn(session) } };
  const outbox = new YdbExceptionOutbox(driver as never);
  await outbox.init();
  assert.equal(creates, 0);
  session.describeTable = async () => {
    describes++;
    if (describes === 2) throw sdkError(StatusCode.SCHEME_ERROR);
  };
  session.createTable = async () => { creates++; throw sdkError(StatusCode.SCHEME_ERROR); };
  await outbox.init();
  assert.equal(creates, 1);
  const permissionError = new Error('No permission');
  session.describeTable = async () => { throw permissionError; };
  await assert.rejects(outbox.init(), error => error === permissionError);
});
