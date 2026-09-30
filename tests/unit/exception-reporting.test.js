"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_url_1 = require("node:url");
const node_path_1 = require("node:path");
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../../packages/observability/dist/index.js");
class Outbox {
    reports = new Map();
    async save(report) { this.reports.set(report.id, report); }
    async pending() { return [...this.reports.values()]; }
    async remove(id) { this.reports.delete(id); }
}
(0, node_test_1.test)('exceptions create bug issues, retain code location, exclude private values and deduplicate propagation', async () => {
    const calls = [];
    const reporter = new index_js_1.GitHubExceptionReporter({
        token: 'private-token', repository: 'owner/repo',
        fetch: (async (url, init) => {
            calls.push({ url: String(url), init });
            return init?.method === 'POST' ? new Response('{}', { status: 201 }) : new Response('[]');
        })
    });
    const error = new TypeError('prompt=private user text; ghp_privatekey; https://private.test?q=secret');
    error.stack = 'TypeError: private\n    at run (/secret/home/app.ts:42:3)\n    at https://private.test/?key=secret';
    reporter.capture(error, 'Process job', { service: 'worker', jobId: 'job_1', prompt: 'private', ownerId: 123 });
    reporter.capture(error, 'Parent catch', {});
    await reporter.flush();
    const posts = calls.filter(call => call.init?.method === 'POST');
    strict_1.default.equal(posts.length, 1);
    const payload = JSON.parse(String(posts[0].init?.body));
    strict_1.default.deepEqual(payload.labels, ['bug']);
    strict_1.default.match(payload.body, /app.ts:42:3/);
    strict_1.default.doesNotMatch(payload.body, /private user text|ghp_privatekey|secret\/home|private.test|ownerId/);
    strict_1.default.equal((posts[0].init?.headers).Authorization, 'Bearer private-token');
});
(0, node_test_1.test)('durable reports survive reporter restart and GitHub failure without recursive reports', async () => {
    const outbox = new Outbox();
    let failures = 0;
    const first = new index_js_1.GitHubExceptionReporter({ token: 'token', repository: 'owner/repo', outbox,
        fetch: (async () => new Response('{}', { status: 503 })),
        onFailure: () => failures++ });
    first.capture(new Error('boom'), 'Process job', {});
    await first.flush();
    strict_1.default.equal(outbox.reports.size, 1);
    strict_1.default.equal(failures, 1);
    const second = new index_js_1.GitHubExceptionReporter({ token: 'token', repository: 'owner/repo', outbox,
        fetch: (async (_url, init) => init?.method === 'POST' ? new Response('{}', { status: 201 }) : new Response('[]')) });
    await second.flush();
    strict_1.default.equal(outbox.reports.size, 0);
});
(0, node_test_1.test)('ambiguous POST success is recovered through issue marker, without another POST', async () => {
    const outbox = new Outbox();
    let remoteIssue;
    let posts = 0;
    const reporter = new index_js_1.GitHubExceptionReporter({ token: 'token', repository: 'owner/repo', outbox,
        fetch: (async (_url, init) => {
            if (init?.method === 'POST') {
                posts++;
                remoteIssue = JSON.parse(String(init.body));
                throw new Error('Connection closed after creation');
            }
            return new Response(JSON.stringify(remoteIssue ? [remoteIssue] : []));
        }) });
    reporter.capture(new Error('boom'), 'Render', {});
    await reporter.flush();
    strict_1.default.equal(outbox.reports.size, 1);
    await reporter.flush();
    strict_1.default.equal(posts, 1);
    strict_1.default.equal(outbox.reports.size, 0);
});
(0, node_test_1.test)('upstream response and SDK HTTP failures stay Info, code errors report despite log threshold', async () => {
    const captures = [];
    (0, index_js_1.setExceptionReporter)({ capture: error => { captures.push(error); }, flush: async () => { } });
    try {
        const logger = new index_js_1.Logger('error').child({ service: 'webhook' });
        logger.exception(new index_js_1.UpstreamResponseError('HTTP 429', 'OpenRouter', 429), 'Complete request');
        logger.exception(Object.assign(new Error('HTTP 500'), { $metadata: { httpStatusCode: 500 } }), 'Publish queue');
        const codeError = new TypeError('bad state');
        logger.exception(codeError, 'Handle event');
        strict_1.default.deepEqual(captures, [codeError]);
    }
    finally {
        (0, index_js_1.setExceptionReporter)(undefined);
    }
});
(0, node_test_1.test)('report body ignores attacker-controlled error properties and context', () => {
    const error = new Error('private');
    error.name = 'ghp_secret';
    error.stack = 'Error: private\n    at secret_TOKEN (/tmp/app.ts:12:5)\n    at ghp_secret';
    const report = (0, index_js_1.buildExceptionReport)(error, 'Read settings', { service: 'worker', article: 'private', url: 'private' });
    strict_1.default.doesNotMatch(JSON.stringify(report), /ghp_secret|secret_TOKEN|"article"|"url"/);
    strict_1.default.match(report.body, /app.ts:12:5/);
    strict_1.default.equal((0, index_js_1.redactSensitiveData)('ghp_abcdef sk-or-v1-abcdefgh'), '[REDACTED] [REDACTED]');
});
(0, node_test_1.test)('received failure responses emit Info at the enclosing exception boundary', () => {
    class RecordingLogger extends index_js_1.Logger {
        levels = [];
        info() { this.levels.push('info'); }
        error() { this.levels.push('error'); }
    }
    const logger = new RecordingLogger();
    logger.exception(new index_js_1.UpstreamResponseError('HTTP 403', 'Article', 403), 'Process job');
    logger.exception(Object.assign(new Error('SDK response'), { $metadata: { httpStatusCode: 503 } }), 'Publish job');
    strict_1.default.deepEqual(logger.levels, ['info', 'info']);
});
(0, node_test_1.test)('uncaught exceptions and unhandled rejections report and flush before process exit', async () => {
    const { spawnSync } = await import('node:child_process');
    const moduleUrl = (0, node_url_1.pathToFileURL)((0, node_path_1.resolve)('packages/observability/dist/index.js')).href;
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
        strict_1.default.equal(child.status, 1, child.stderr);
        strict_1.default.match(child.stdout, new RegExp(`capture:${operation}`));
        strict_1.default.match(child.stdout, /flushed/);
    }
});
(0, node_test_1.test)('persistent outbox startup tolerates an existing table and concurrent creation, but rejects permission failures', async () => {
    const { YdbExceptionOutbox } = await import('../../packages/jobs/dist/index.js');
    const { StatusCode } = await import('ydb-sdk');
    const sdkError = (status) => new (class extends Error {
        static status = status;
    })();
    let creates = 0;
    let describes = 0;
    const session = {
        async describeTable() { describes++; },
        async createTable() { creates++; }
    };
    const driver = { tableClient: { withSession: async (fn) => fn(session) } };
    const outbox = new YdbExceptionOutbox(driver);
    await outbox.init();
    strict_1.default.equal(creates, 0);
    session.describeTable = async () => {
        describes++;
        if (describes === 2)
            throw sdkError(StatusCode.SCHEME_ERROR);
    };
    session.createTable = async () => { creates++; throw sdkError(StatusCode.SCHEME_ERROR); };
    await outbox.init();
    strict_1.default.equal(creates, 1);
    const permissionError = new Error('No permission');
    session.describeTable = async () => { throw permissionError; };
    await strict_1.default.rejects(outbox.init(), error => error === permissionError);
});
//# sourceMappingURL=exception-reporting.test.js.map