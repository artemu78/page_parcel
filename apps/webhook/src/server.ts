import * as http from 'node:http';
import { Logger, defaultLogger, metrics } from '@readable-web/observability';
import { WebhookHandler } from './handler.js';

export interface WebhookServerOptions {
  port?: number;
  handler: WebhookHandler;
  logger?: Logger;
  maxBodyBytes?: number;
}

export class WebhookServer {
  private server: http.Server;
  private port: number;
  private handler: WebhookHandler;
  private logger: Logger;
  private maxBodyBytes: number;

  constructor(options: WebhookServerOptions) {
    this.port = options.port ?? (Number.parseInt(process.env.PORT || '8080', 10));
    this.handler = options.handler;
    this.logger = (options.logger ?? defaultLogger).child({ component: 'WebhookServer' });
    this.maxBodyBytes = options.maxBodyBytes ?? 100 * 1024; // 100 KB limit

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
        this.logger.info(`Webhook Server listening on port ${port}`);
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

    if (method === 'POST' && (url === '/vk/callback' || url === '/')) {
      // Read body with bounded size check
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > this.maxBodyBytes) {
          req.destroy();
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Payload Too Large');
        } else {
          chunks.push(chunk);
        }
      });

      req.on('end', async () => {
        try {
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          const bodyJson = JSON.parse(bodyStr);

          const result = await this.handler.handleRequest(bodyJson);
          res.writeHead(result.statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(result.body);
        } catch (err) {
          this.logger.error(`Error processing webhook request: ${(err as Error).message}`);
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
        }
      });

      req.on('error', (err) => {
        this.logger.error(`Incoming connection error: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}
