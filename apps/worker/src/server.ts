import * as http from 'node:http';
import { Logger, defaultLogger, metrics } from '@readable-web/observability';
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
    this.port = options.port ?? (Number.parseInt(process.env.WORKER_PORT || process.env.PORT || '8081', 10));
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
          const bodyJson = JSON.parse(bodyStr);

          // Support both standard Yandex Message Queue Trigger payload:
          // { "messages": [ { "details": { "body": "...", "message_id": "..." } } ] }
          // and direct JSON payload { "jobId": "..." }
          let jobIds: string[] = [];

          if (Array.isArray(bodyJson?.messages) && bodyJson.messages.length > 0) {
            for (const msg of bodyJson.messages) {
              const rawBody = msg?.details?.body;
              if (rawBody) {
                try {
                  const parsedMsg = JSON.parse(rawBody) as JobQueueMessage;
                  if (parsedMsg.jobId) jobIds.push(parsedMsg.jobId);
                } catch {
                  // If rawBody is just the jobId string
                  jobIds.push(rawBody);
                }
              }
            }
          } else if (bodyJson?.jobId) {
            jobIds.push(bodyJson.jobId);
          }

          if (jobIds.length === 0) {
            this.logger.warn('Trigger payload contained no recognized job IDs');
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
          this.logger.error(`Error processing trigger payload: ${(err as Error).message}`);
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
