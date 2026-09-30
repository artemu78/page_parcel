import { randomUUID } from 'node:crypto';

/** A received upstream response is operational information, not a code exception. */
export class UpstreamResponseError extends Error {
  constructor(message: string, public readonly service: string, public readonly statusCode: number) {
    super(message);
    this.name = 'UpstreamResponseError';
  }
}

export interface ExceptionReport {
  id: string;
  title: string;
  body: string;
}

export interface ExceptionOutbox {
  save(report: ExceptionReport): Promise<void>;
  pending(): Promise<ExceptionReport[]>;
  remove(id: string): Promise<void>;
}

export interface ExceptionReporter {
  capture(error: unknown, operation: string, context: Record<string, unknown>): void;
  flush(): Promise<void>;
}

export interface GitHubExceptionReporterOptions {
  token: string;
  repository: string;
  service?: string;
  fetch?: typeof fetch;
  outbox?: ExceptionOutbox;
  onInfo?: (status: number) => void;
  onFailure?: (reportId: string) => void;
}

// Public issues must never contain user content, submitted URLs, or exception messages.
// Messages can embed arbitrary HTTP bodies or prompts. Keep only code frames and fixed context.
export function buildExceptionReport(error: unknown, operation: string, context: Record<string, unknown>): ExceptionReport {
  const frames = error instanceof Error
    ? (error.stack ?? '').split('\n').flatMap(line => {
        const match = line.match(/^\s+at (?:(?:[a-zA-Z0-9_.$ <>]+) \()?[^\s]*[/\\]([a-zA-Z0-9_.-]+:\d+:\d+)\)?$/);
        return match && !/(?:github_pat_|gh[pousr]_|sk-)/i.test(match[1]) ? [`    at ${match[1]}`] : [];
      }).slice(0, 15).join('\n')
    : '';
  const safeContext: Record<string, string | number> = {};
  for (const key of ['service', 'component', 'jobId', 'requestId', 'attempts']) {
    const value = context[key];
    if (typeof value === 'number' || (typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value))) {
      safeContext[key] = value;
    }
  }
  const id = randomUUID();
  const kind = error instanceof TypeError ? 'TypeError' : error instanceof SyntaxError ? 'SyntaxError' : 'Exception';
  // operation is a developer-defined label, never interpolate request data into it.
  const safeOperation = operation.replace(/[^a-zA-Z0-9 _.:-]/g, '').slice(0, 120);
  return {
    id,
    title: `[bug] ${safeContext.service ?? 'runtime'}: ${safeOperation} (${kind})`,
    body: `<!-- exception-report:${id} -->\nCode exception captured at ${new Date().toISOString()}.\n\nOperation: ${safeOperation}\n\nContext:\n\`\`\`json\n${JSON.stringify(safeContext, null, 2)}\n\`\`\`\n\nCode frames:\n\`\`\`text\n${frames || '(unavailable)'}\n\`\`\`\n\nException messages and private payloads are intentionally omitted. Correlate with sanitized service logs.`
  };
}

export class GitHubExceptionReporter implements ExceptionReporter {
  private reports = new Map<string, ExceptionReport>();
  private seen = new WeakSet<object>();
  private requested = false;
  private flushing?: Promise<void>;
  private request: typeof fetch;
  private endpoint: string;

  constructor(private options: GitHubExceptionReporterOptions) {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(options.repository)) {
      throw new Error('GITHUB_REPOSITORY must be owner/repository');
    }
    this.endpoint = `https://api.github.com/repos/${options.repository}/issues`;
    this.request = options.fetch ?? fetch;
  }

  capture(error: unknown, operation: string, context: Record<string, unknown>): void {
    if (error instanceof UpstreamResponseError) return;
    if (error !== null && typeof error === 'object') {
      if (this.seen.has(error)) return;
      this.seen.add(error);
    }
    const report = buildExceptionReport(error, operation, { service: this.options.service, ...context });
    this.reports.set(report.id, report);
    // Start delivery immediately; flush also runs at request/shutdown boundaries.
    this.requested = true;
    void this.flush();
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      do { this.requested = false; await this.drain(); } while (this.requested);
    })().catch(() => {
      this.options.onFailure?.('outbox');
    }).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    const deadline = Date.now() + 60000;
    let pending = [...this.reports.values()];
    if (this.options.outbox) {
      for (const report of pending) {
        if (Date.now() >= deadline) break;
        await this.options.outbox.save(report);
        this.reports.delete(report.id);
      }
      pending = await this.options.outbox.pending();
    }
    for (const report of pending) {
      if (Date.now() >= deadline) break;
      try {
        // A stable marker lets a retry recover an ambiguous POST result without creating another issue.
        const capturedAt = report.body.match(/captured at (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/)?.[1];
        const since = capturedAt ? `&since=${encodeURIComponent(new Date(Date.parse(capturedAt) - 60000).toISOString())}` : '';
        let exists = false;
        for (let page = 1; ; page++) {
          const list = await this.request(`${this.endpoint}?state=all&sort=created&direction=desc&per_page=100&page=${page}${since}`, {
            headers: this.headers(), signal: AbortSignal.timeout(5000), redirect: 'error'
          });
          this.options.onInfo?.(list.status);
          if (!list.ok) { await list.body?.cancel(); throw new Error('GitHub list failed'); }
          const issues = await list.json() as Array<{ body?: string; pull_request?: unknown }>;
          exists = issues.some(issue => !issue.pull_request && issue.body?.includes(`<!-- exception-report:${report.id} -->`));
          if (exists || issues.length < 100) break;
          // Stay within the lease even for a large repository; retry rather than risk duplicate POSTs.
          if (page >= 10 || Date.now() >= deadline) throw new Error('GitHub issue lookup exceeded page budget');
        }
        if (!exists) {
          const response = await this.request(this.endpoint, {
            method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(5000), redirect: 'error',
            body: JSON.stringify({ title: report.title, body: report.body, labels: ['bug'] })
          });
          this.options.onInfo?.(response.status);
          await response.body?.cancel();
          if (response.status !== 201) throw new Error('GitHub creation failed');
        }
        await this.options.outbox?.remove(report.id);
        this.reports.delete(report.id);
      } catch {
        // Do not recursively report reporting failures; retain for the next flush.
        this.options.onFailure?.(report.id);
        break;
      }
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ReadableWeb-ExceptionReporter'
    };
  }
}

let reporter: ExceptionReporter | undefined;
export function setExceptionReporter(value: ExceptionReporter | undefined): void { reporter = value; }
export function captureException(error: unknown, operation: string, context: Record<string, unknown> = {}): void {
  reporter?.capture(error, operation, context);
}
export async function flushExceptionReports(): Promise<void> { await reporter?.flush(); }
