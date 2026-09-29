import * as http from 'node:http';
import * as net from 'node:net';
import { SafeDnsResolver, defaultDnsResolver } from './dns-resolver.js';
import { validateUrlSyntax } from './url-validator.js';
import { Logger, defaultLogger, metrics } from '@readable-web/observability';

export interface EgressProxyLimits {
  maxRequestsPerJob?: number;
  maxBytesPerResponse?: number;
  maxAggregateBytes?: number;
}

export interface EgressProxyOptions {
  port?: number;
  host?: string;
  dnsResolver?: SafeDnsResolver;
  logger?: Logger;
  limits?: EgressProxyLimits;
}

export class ValidatingEgressProxy {
  private server: http.Server;
  private port: number;
  private host: string;
  private dnsResolver: SafeDnsResolver;
  private logger: Logger;

  private maxRequestsPerJob: number;
  private maxBytesPerResponse: number;
  private maxAggregateBytes: number;

  private totalRequests = 0;
  private totalBytesTransferred = 0;
  private activeSockets = new Set<net.Socket>();

  constructor(options: EgressProxyOptions = {}) {
    this.port = options.port ?? 0;
    this.host = options.host ?? '127.0.0.1';
    this.dnsResolver = options.dnsResolver ?? defaultDnsResolver;
    this.logger = (options.logger ?? defaultLogger).child({ component: 'EgressProxy' });

    const envMaxRequests = process.env.MAX_REQUESTS_PER_JOB ? parseInt(process.env.MAX_REQUESTS_PER_JOB, 10) : undefined;
    this.maxRequestsPerJob = options.limits?.maxRequestsPerJob ?? (envMaxRequests && !isNaN(envMaxRequests) ? envMaxRequests : 500);
    this.maxBytesPerResponse = options.limits?.maxBytesPerResponse ?? 5 * 1024 * 1024; // 5 MiB
    this.maxAggregateBytes = options.limits?.maxAggregateBytes ?? 20 * 1024 * 1024; // 20 MiB

    this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.server.on('connect', (req, clientSocket, head) => this.handleConnect(req, clientSocket as net.Socket, head));
  }

  public getPort(): number {
    const addr = this.server.address();
    if (addr && typeof addr === 'object') {
      return addr.port;
    }
    return this.port;
  }

  public getProxyUrl(): string {
    return `http://${this.host}:${this.getPort()}`;
  }

  public getStats() {
    return {
      totalRequests: this.totalRequests,
      totalBytesTransferred: this.totalBytesTransferred,
      activeConnections: this.activeSockets.size
    };
  }

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        const actualPort = this.getPort();
        this.port = actualPort;
        this.logger.info(`Validating Egress Proxy started on ${this.host}:${actualPort}`);
        resolve(actualPort);
      });
      this.server.on('error', reject);
    });
  }

  public async stop(): Promise<void> {
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private incrementRequests(): void {
    this.totalRequests++;
    if (this.totalRequests > this.maxRequestsPerJob) {
      metrics.blockedDestinationsTotal.inc({ reason: 'MAX_REQUESTS_EXCEEDED' });
      throw new Error(`Job exceeded maximum allowed request count (${this.maxRequestsPerJob})`);
    }
  }

  private trackBytes(bytes: number, streamBytes: { count: number }): void {
    streamBytes.count += bytes;
    this.totalBytesTransferred += bytes;

    if (streamBytes.count > this.maxBytesPerResponse) {
      metrics.blockedDestinationsTotal.inc({ reason: 'RESPONSE_SIZE_EXCEEDED' });
      throw new Error(`Response stream exceeded maximum size (${this.maxBytesPerResponse} bytes)`);
    }

    if (this.totalBytesTransferred > this.maxAggregateBytes) {
      metrics.blockedDestinationsTotal.inc({ reason: 'AGGREGATE_SIZE_EXCEEDED' });
      throw new Error(`Job exceeded aggregate network transfer limit (${this.maxAggregateBytes} bytes)`);
    }
  }

  // Handle HTTPS CONNECT tunnel
  private async handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): Promise<void> {
    this.activeSockets.add(clientSocket);
    clientSocket.once('close', () => this.activeSockets.delete(clientSocket));

    try {
      this.incrementRequests();
    } catch (err) {
      this.logger.warn(`CONNECT rejected due to request limits: ${(err as Error).message}`);
      clientSocket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const rawUrl = req.url || '';
    const [targetHost, targetPortStr] = rawUrl.split(':');
    const targetPort = targetPortStr ? Number.parseInt(targetPortStr, 10) : 443;

    if (!targetHost || Number.isNaN(targetPort) || (targetPort !== 443 && targetPort !== 80)) {
      this.logger.warn(`CONNECT rejected: prohibited destination or port: ${rawUrl}`);
      metrics.blockedDestinationsTotal.inc({ reason: 'INVALID_PORT' });
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // Prevalidate target hostname / IP
    try {
      validateUrlSyntax(`https://${targetHost}:${targetPort}`);
    } catch (err) {
      this.logger.warn(`CONNECT rejected by URL syntax/IP rule: ${(err as Error).message}`);
      metrics.blockedDestinationsTotal.inc({ reason: 'SSRF_SYNTAX_REJECTED' });
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // Resolve DNS at connection time
    let validatedIp: string;
    try {
      if (net.isIP(targetHost)) {
        validatedIp = targetHost;
      } else {
        const resolved = await this.dnsResolver.resolve(targetHost);
        validatedIp = resolved.selectedIp;
      }
    } catch (err) {
      this.logger.warn(`CONNECT rejected by DNS validation: ${(err as Error).message}`);
      metrics.blockedDestinationsTotal.inc({ reason: 'SSRF_DNS_REJECTED' });
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // Connect to the safe validated IP directly
    const upstreamSocket = net.connect({ host: validatedIp, port: targetPort }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }
    });

    this.activeSockets.add(upstreamSocket);
    upstreamSocket.once('close', () => this.activeSockets.delete(upstreamSocket));

    const streamBytes = { count: 0 };

    upstreamSocket.on('data', (chunk) => {
      try {
        this.trackBytes(chunk.length, streamBytes);
        clientSocket.write(chunk);
      } catch (err) {
        this.logger.warn(`CONNECT stream terminated: ${(err as Error).message}`);
        upstreamSocket.destroy();
        clientSocket.destroy();
      }
    });

    clientSocket.on('data', (chunk) => {
      upstreamSocket.write(chunk);
    });

    upstreamSocket.on('error', (err) => {
      this.logger.debug(`Upstream socket error: ${err.message}`);
      clientSocket.destroy();
    });

    clientSocket.on('error', (err) => {
      this.logger.debug(`Client socket error: ${err.message}`);
      upstreamSocket.destroy();
    });

    upstreamSocket.on('end', () => clientSocket.end());
    clientSocket.on('end', () => upstreamSocket.end());
  }

  // Handle plain HTTP proxy requests
  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      this.incrementRequests();
    } catch (err) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end((err as Error).message);
      return;
    }

    const rawUrl = req.url;
    if (!rawUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing request URL');
      return;
    }

    let parsedUrl: URL;
    try {
      // If it's a relative path in forward proxy, reconstruct from Host header
      parsedUrl = rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
        ? new URL(rawUrl)
        : new URL(`http://${req.headers.host}${rawUrl}`);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Invalid request URL: ${(err as Error).message}`);
      return;
    }

    try {
      validateUrlSyntax(parsedUrl.toString());
    } catch (err) {
      metrics.blockedDestinationsTotal.inc({ reason: 'SSRF_SYNTAX_REJECTED' });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`Forbidden destination: ${(err as Error).message}`);
      return;
    }

    // Resolve DNS
    let validatedIp: string;
    try {
      if (net.isIP(parsedUrl.hostname)) {
        validatedIp = parsedUrl.hostname;
      } else {
        const resolved = await this.dnsResolver.resolve(parsedUrl.hostname);
        validatedIp = resolved.selectedIp;
      }
    } catch (err) {
      metrics.blockedDestinationsTotal.inc({ reason: 'SSRF_DNS_REJECTED' });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`Forbidden DNS destination: ${(err as Error).message}`);
      return;
    }

    const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : 80;

    const proxyHeaders = { ...req.headers };
    proxyHeaders.host = parsedUrl.host;
    delete proxyHeaders['proxy-connection'];

    const streamBytes = { count: 0 };

    const upstreamReq = http.request(
      {
        host: validatedIp,
        port,
        method: req.method,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: proxyHeaders,
        timeout: 10000
      },
      (upstreamRes) => {
        // Forward headers
        res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);

        upstreamRes.on('data', (chunk) => {
          try {
            this.trackBytes(chunk.length, streamBytes);
            res.write(chunk);
          } catch (err) {
            this.logger.warn(`HTTP stream terminated: ${(err as Error).message}`);
            upstreamReq.destroy();
            res.destroy();
          }
        });

        upstreamRes.on('end', () => res.end());
      }
    );

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        res.end('Gateway Timeout');
      }
    });

    upstreamReq.on('error', (err) => {
      this.logger.warn(`Upstream HTTP request failed: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway');
      }
    });

    req.pipe(upstreamReq);
  }
}
