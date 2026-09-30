import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as zlib from 'node:zlib';
import { validateUrlSyntax } from './url-validator.js';
import { SafeDnsResolver, defaultDnsResolver } from './dns-resolver.js';
import { Logger, defaultLogger } from '@readable-web/observability';

export interface SafeFetchOptions {
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  dnsResolver?: SafeDnsResolver;
  logger?: Logger;
}

export interface SafeFetchResponse {
  finalUrl: string;
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  redirectsCount: number;
}

export async function safeFetch(
  initialUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResponse> {
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024; // 5 MiB
  const timeoutMs = options.timeoutMs ?? 15000;
  const dnsResolver = options.dnsResolver ?? defaultDnsResolver;
  const logger = (options.logger ?? defaultLogger).child({ component: 'SafeFetch' });

  let currentUrl = initialUrl;
  let redirectsCount = 0;

  while (true) {
    const validated = validateUrlSyntax(currentUrl);

    // Resolve DNS
    let targetIp: string;
    if (validated.isDirectIp && validated.directIp) {
      targetIp = validated.directIp;
    } else {
      const resolved = await dnsResolver.resolve(validated.hostname);
      targetIp = resolved.selectedIp;
    }

    const isHttps = validated.protocol === 'https:';
    const requestModule = isHttps ? https : http;

    const requestOptions: https.RequestOptions = {
      host: targetIp,
      port: validated.port,
      path: validated.pathname + validated.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (ReadableWeb/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Host': validated.hostname + (validated.port !== 80 && validated.port !== 443 ? `:${validated.port}` : ''),
        ...(options.headers || {})
      },
      timeout: timeoutMs,
      // For HTTPS, preserve the servername for SNI and verify cert against hostname
      servername: isHttps ? validated.hostname : undefined
    };

    const response = await new Promise<{
      statusCode: number;
      headers: http.IncomingHttpHeaders;
      body: Buffer;
    }>((resolve, reject) => {
      const req = requestModule.request(requestOptions, (res) => {
        logger.info('Article HTTP response', { httpStatus: res.statusCode });
        let stream: NodeJS.ReadableStream = res;
        const encoding = res.headers['content-encoding'];

        if (encoding === 'gzip') {
          stream = res.pipe(zlib.createGunzip());
        } else if (encoding === 'deflate') {
          stream = res.pipe(zlib.createInflate());
        } else if (encoding === 'br') {
          stream = res.pipe(zlib.createBrotliDecompress());
        }

        const chunks: Buffer[] = [];
        let totalReceived = 0;

        stream.on('data', (chunk: Buffer) => {
          totalReceived += chunk.length;
          if (totalReceived > maxBytes) {
            req.destroy();
            res.destroy();
            reject(new Error(`Response size exceeded limit of ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });

        stream.on('end', () => {
          resolve({
            statusCode: res.statusCode || 200,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });

        stream.on('error', (err) => reject(err));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      });

      req.on('error', (err) => reject(err));
      req.end();
    });

    // Check redirect status codes (301, 302, 303, 307, 308)
    const isRedirect = [301, 302, 303, 307, 308].includes(response.statusCode);
    if (isRedirect && response.headers.location) {
      redirectsCount++;
      if (redirectsCount > maxRedirects) {
        throw new Error(`Exceeded maximum allowed redirects (${maxRedirects})`);
      }

      const redirectTarget = new URL(response.headers.location, currentUrl).toString();
      logger.debug(`Following redirect #${redirectsCount} to ${redirectTarget}`);
      currentUrl = redirectTarget;
      continue;
    }

    return {
      finalUrl: currentUrl,
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
      redirectsCount
    };
  }
}
