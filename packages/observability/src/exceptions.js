"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubExceptionReporter = exports.UpstreamResponseError = void 0;
exports.buildExceptionReport = buildExceptionReport;
exports.setExceptionReporter = setExceptionReporter;
exports.captureException = captureException;
exports.flushExceptionReports = flushExceptionReports;
const node_crypto_1 = require("node:crypto");
const redaction_js_1 = require("./redaction.js");
/** A received upstream response is operational information, not a code exception. */
class UpstreamResponseError extends Error {
    service;
    statusCode;
    constructor(message, service, statusCode) {
        super(message);
        this.service = service;
        this.statusCode = statusCode;
        this.name = 'UpstreamResponseError';
    }
}
exports.UpstreamResponseError = UpstreamResponseError;
// Report the diagnostic message, with credential and URL redaction; never export arbitrary context.
function buildExceptionReport(error, operation, context) {
    const frames = error instanceof Error
        ? (error.stack ?? '').split('\n').flatMap(line => {
            const match = line.match(/^\s+at (?:(?:[a-zA-Z0-9_.$ <>]+) \()?[^\s]*[/\\]([a-zA-Z0-9_.-]+:\d+:\d+)\)?$/);
            return match && !/(?:github_pat_|gh[pousr]_|sk-)/i.test(match[1]) ? [`    at ${match[1]}`] : [];
        }).slice(0, 15).join('\n')
        : '';
    const safeContext = {};
    for (const key of ['service', 'component', 'jobId', 'requestId', 'attempts']) {
        const value = context[key];
        if (typeof value === 'number' || (typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value))) {
            safeContext[key] = value;
        }
    }
    const appVersion = (0, redaction_js_1.redactSensitiveData)(process.env.APP_VERSION || 'unknown (APP_VERSION not set)')
        .replace(/[\r\n`]/g, ' ').slice(0, 256);
    const message = (0, redaction_js_1.redactSensitiveData)(error instanceof Error ? error.message : String(error))
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL REDACTED]');
    const errorText = message.length > 12000 ? message.slice(0, 12000) + '\n[truncated]' : message;
    // An exception may contain Markdown fences; keep its text inside a single code block.
    const fenceLength = Math.max(3, ...Array.from(errorText.matchAll(/`+/g), match => match[0].length + 1));
    const errorBlock = `${'`'.repeat(fenceLength)}text\n${errorText}\n${'`'.repeat(fenceLength)}`;
    const id = (0, node_crypto_1.randomUUID)();
    const kind = error instanceof TypeError ? 'TypeError' : error instanceof SyntaxError ? 'SyntaxError' : 'Exception';
    // operation is a developer-defined label, never interpolate request data into it.
    const safeOperation = operation.replace(/[^a-zA-Z0-9 _.:-]/g, '').slice(0, 120);
    return {
        id,
        title: `[bug] ${safeContext.service ?? 'runtime'}: ${safeOperation} (${kind})`,
        body: `<!-- exception-report:${id} -->\nCode exception captured at ${new Date().toISOString()}.\n\nApp version: ${appVersion}\n\nOperation: ${safeOperation}\n\nError text:\n${errorBlock}\n\nContext:\n\`\`\`json\n${JSON.stringify(safeContext, null, 2)}\n\`\`\`\n\nCode frames:\n\`\`\`text\n${frames || '(unavailable)'}\n\`\`\`\n\nCredentials and URLs are redacted from error text. Additional request payloads and arbitrary exception properties are omitted.`
    };
}
class GitHubExceptionReporter {
    options;
    reports = new Map();
    seen = new WeakSet();
    requested = false;
    flushing;
    request;
    endpoint;
    constructor(options) {
        this.options = options;
        if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(options.repository)) {
            throw new Error('GITHUB_REPOSITORY must be owner/repository');
        }
        this.endpoint = `https://api.github.com/repos/${options.repository}/issues`;
        this.request = options.fetch ?? fetch;
    }
    capture(error, operation, context) {
        if (error instanceof UpstreamResponseError)
            return;
        if (error !== null && typeof error === 'object') {
            if (this.seen.has(error))
                return;
            this.seen.add(error);
        }
        const report = buildExceptionReport(error, operation, { service: this.options.service, ...context });
        this.reports.set(report.id, report);
        // Start delivery immediately; flush also runs at request/shutdown boundaries.
        this.requested = true;
        void this.flush();
    }
    flush() {
        if (this.flushing)
            return this.flushing;
        this.flushing = (async () => {
            do {
                this.requested = false;
                await this.drain();
            } while (this.requested);
        })().catch(() => {
            this.options.onFailure?.('outbox');
        }).finally(() => { this.flushing = undefined; });
        return this.flushing;
    }
    async drain() {
        const deadline = Date.now() + 60000;
        let pending = [...this.reports.values()];
        if (this.options.outbox) {
            for (const report of pending) {
                if (Date.now() >= deadline)
                    break;
                await this.options.outbox.save(report);
                this.reports.delete(report.id);
            }
            pending = await this.options.outbox.pending();
        }
        for (const report of pending) {
            if (Date.now() >= deadline)
                break;
            try {
                // A stable marker lets a retry recover an ambiguous POST result without creating another issue.
                const capturedAt = report.body.match(/captured at (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/)?.[1];
                const since = capturedAt ? `&since=${encodeURIComponent(new Date(Date.parse(capturedAt) - 60000).toISOString())}` : '';
                let exists = false;
                for (let page = 1;; page++) {
                    const list = await this.request(`${this.endpoint}?state=all&sort=created&direction=desc&per_page=100&page=${page}${since}`, {
                        headers: this.headers(), signal: AbortSignal.timeout(5000), redirect: 'error'
                    });
                    this.options.onInfo?.(list.status);
                    if (!list.ok) {
                        await list.body?.cancel();
                        throw new Error('GitHub list failed');
                    }
                    const issues = await list.json();
                    exists = issues.some(issue => !issue.pull_request && issue.body?.includes(`<!-- exception-report:${report.id} -->`));
                    if (exists || issues.length < 100)
                        break;
                    // Stay within the lease even for a large repository; retry rather than risk duplicate POSTs.
                    if (page >= 10 || Date.now() >= deadline)
                        throw new Error('GitHub issue lookup exceeded page budget');
                }
                if (!exists) {
                    const response = await this.request(this.endpoint, {
                        method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(5000), redirect: 'error',
                        body: JSON.stringify({ title: report.title, body: report.body, labels: ['bug'] })
                    });
                    this.options.onInfo?.(response.status);
                    await response.body?.cancel();
                    if (response.status !== 201)
                        throw new Error('GitHub creation failed');
                }
                await this.options.outbox?.remove(report.id);
                this.reports.delete(report.id);
            }
            catch {
                // Do not recursively report reporting failures; retain for the next flush.
                this.options.onFailure?.(report.id);
                break;
            }
        }
    }
    headers() {
        return {
            Authorization: `Bearer ${this.options.token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'ReadableWeb-ExceptionReporter'
        };
    }
}
exports.GitHubExceptionReporter = GitHubExceptionReporter;
let reporter;
function setExceptionReporter(value) { reporter = value; }
function captureException(error, operation, context = {}) {
    reporter?.capture(error, operation, context);
}
async function flushExceptionReports() { await reporter?.flush(); }
//# sourceMappingURL=exceptions.js.map