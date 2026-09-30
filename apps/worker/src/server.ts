import * as http from 'node:http';
import { Logger, defaultLogger, metrics, flushExceptionReports } from '@readable-web/observability';
import { JobProcessor } from './job-processor.js';
import { JobQueueMessage } from '@readable-web/jobs';

export interface WorkerServerOptions {
  port?: number;
  processor: JobProcessor;
  logger?: Logger;
  triggerSecret?: string;
}

export class WorkerServer {
  private server: http.Server;
  private port: number;
  private processor: JobProcessor;
  private logger: Logger;
  private triggerSecret?: string;

  constructor(options: WorkerServerOptions) {
    this.port = options.port ?? (Number.parseInt(process.env.PORT || process.env.WORKER_PORT || '8080', 10));
    this.processor = options.processor;
    this.logger = (options.logger ?? defaultLogger).child({ component: 'WorkerServer' });
    this.triggerSecret = options.triggerSecret;

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  public getPort(): number {
    const addr = this.server.address();
    if (addr && typeof addr === 'object') {
      return addr.port;
    }
    return this.port;
  }

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        const port = this.getPort();
        this.port = port;
        this.logger.info(`Worker Server listening on port ${port}`);
        resolve(port);
      });
      this.server.on('error', reject);
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (method === 'GET' && (url === '/healthz' || url === '/readyz')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }

    if (method === 'GET' && url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metrics.toPrometheusText());
      return;
    }

    if (method === 'POST') {
      // Optional trigger authentication check
      if (this.triggerSecret) {
        const authHeader = req.headers['authorization'] || req.headers['x-trigger-secret'];
        const expectedAuth = `Bearer ${this.triggerSecret}`;
        if (authHeader !== expectedAuth && authHeader !== this.triggerSecret) {
          this.logger.warn('Unauthorized trigger invocation attempt');
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Unauthorized');
          return;
        }
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          let bodyJson;
          try {
            bodyJson = JSON.parse(bodyStr);
          } catch {
            this.logger.warn('Invalid request JSON');
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad Request');
            return;
          }

          this.logger.info(`Received trigger payload: ${bodyStr.slice(0, 500)}`);

          let jobIds: string[] = [];

          // 1. Check messages array (standard YMQ trigger)
          if (Array.isArray(bodyJson?.messages) && bodyJson.messages.length > 0) {
            for (const msg of bodyJson.messages) {
              const rawBody = msg?.details?.body ?? msg?.details?.message?.body ?? msg?.body ?? msg?.details?.message;
              if (rawBody) {
                if (typeof rawBody === 'object' && rawBody.jobId) {
                  jobIds.push(rawBody.jobId);
                } else if (typeof rawBody === 'string') {
                  try {
                    const parsedMsg = JSON.parse(rawBody) as JobQueueMessage;
                    if (parsedMsg.jobId) jobIds.push(parsedMsg.jobId);
                  } catch {
                    // Try base64
                    try {
                      const decoded = Buffer.from(rawBody, 'base64').toString('utf-8');
                      const parsed = JSON.parse(decoded) as JobQueueMessage;
                      if (parsed.jobId) jobIds.push(parsed.jobId);
                    } catch {
                      if (rawBody.startsWith('job_')) jobIds.push(rawBody);
                    }
                  }
                }
              }
            }
          } else if (bodyJson?.jobId) {
            jobIds.push(bodyJson.jobId);
          }

          // 2. Fallback: extract any job ID matching pattern job_<timestamp>_<hash>
          if (jobIds.length === 0) {
            const matches = bodyStr.match(/job_\d+_[a-z0-9]+/g);
            if (matches && matches.length > 0) {
              jobIds = Array.from(new Set(matches));
              this.logger.info(`Extracted job IDs via pattern match: ${jobIds.join(', ')}`);
            }
          }

          if (jobIds.length === 0) {
            this.logger.warn(`Trigger payload contained no recognized job IDs: ${bodyStr}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ignored', reason: 'no_jobs' }));
            return;
          }

          // Process jobs sequentially (trigger configured with batch size 1)
          let hasRetryableFailure = false;

          for (const jobId of jobIds) {
            const outcome = await this.processor.processJob(jobId);
            if (outcome.retryable) {
              hasRetryableFailure = true;
            }
          }

          await flushExceptionReports();
          if (hasRetryableFailure) {
            // Return 500 so YMQ trigger does NOT ack and retries after visibility timeout
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Retryable processing error');
          } else {
            // Return 200 OK so YMQ trigger deletes message
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', processed: jobIds.length }));
          }
        } catch (err) {
          this.logger.exception(err, 'Error processing trigger payload');
          await flushExceptionReports();
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}
