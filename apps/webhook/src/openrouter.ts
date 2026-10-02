import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Logger, defaultLogger, redactSensitiveData, UpstreamResponseError } from '@readable-web/observability';

export interface OpenRouterClientOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  proxyUrl?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export interface OpenRouterCompletionParams {
  prompt: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  baseUrl?: string;
  proxyUrl?: string;
}

export class OpenRouterClient {
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private proxyUrl?: string;
  private timeoutMs: number;
  private logger: Logger;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.defaultModel = options.defaultModel ?? 'google/gemini-2.5-flash';
    this.proxyUrl = options.proxyUrl ?? process.env.OPENROUTER_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.https_proxy ?? process.env.http_proxy;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.logger = (options.logger ?? defaultLogger).child({ component: 'OpenRouterClient' });
  }

  public async complete(params: OpenRouterCompletionParams): Promise<string> {
    const model = params.model || this.defaultModel;
    const effectiveBaseUrl = (params.baseUrl || this.baseUrl).replace(/\/+$/, '');
    const targetUrl = new URL(`${effectiveBaseUrl}/chat/completions`);

    const messages: Array<{ role: string; content: string }> = [];
    if (params.systemPrompt) {
      messages.push({ role: 'system', content: params.systemPrompt });
    }
    messages.push(...(params.history ?? []));
    messages.push({ role: 'user', content: params.prompt });

    const payload = JSON.stringify({
      model,
      messages,
      ...(params.maxTokens ? { max_tokens: params.maxTokens } : {})
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Length': String(Buffer.byteLength(payload)),
      'HTTP-Referer': 'https://vk.com',
      'X-Title': 'Readable Web Bot',
      'User-Agent': 'ReadableWeb/1.0'
    };

    const effectiveProxy = params.proxyUrl !== undefined ? params.proxyUrl : this.proxyUrl;
    const isLoopback = targetUrl.hostname === 'localhost' || targetUrl.hostname === '127.0.0.1' || targetUrl.hostname === '::1';
    const hasProxy = typeof effectiveProxy === 'string' && effectiveProxy.trim().length > 0;
    const agent = (hasProxy && !isLoopback) ? new HttpsProxyAgent(effectiveProxy) : undefined;

    return new Promise<string>((resolve, reject) => {
      const isHttps = targetUrl.protocol === 'https:';
      const requestFn = isHttps ? https.request : http.request;

      const req = requestFn(
        targetUrl,
        {
          method: 'POST',
          headers,
          agent,
          timeout: this.timeoutMs
        },
        (res) => {
          this.logger.info('OpenRouter HTTP response', { httpStatus: res.statusCode });
          let data = '';
          res.setEncoding('utf8');

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              return reject(new UpstreamResponseError(`OpenRouter API error (HTTP ${res.statusCode})`, 'OpenRouter', res.statusCode));
            }

            try {
              const json = JSON.parse(data);
              const content = json.choices?.[0]?.message?.content;
              if (typeof content !== 'string') {
                return reject(new UpstreamResponseError('OpenRouter response did not contain message content', 'OpenRouter', res.statusCode ?? 200));
              }
              resolve(content.trim());
            } catch (err) {
              reject(new UpstreamResponseError('Failed to parse OpenRouter response', 'OpenRouter', res.statusCode ?? 200));
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`OpenRouter request timed out after ${this.timeoutMs}ms`));
      });

      req.on('error', (err) => {
        this.logger.exception(err, 'OpenRouter network request');
        reject(err);
      });

      req.write(payload);
      req.end();
    });
  }
}

/**
 * Splits a text into chunks not exceeding maxChunkLength characters (default 4000 for VK API 4096 character limit).
 */
export function splitMessage(text: string, maxChunkLength = 4000): string[] {
  if (text.length <= maxChunkLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkLength) {
      chunks.push(remaining);
      break;
    }

    // Try finding newline break within limit
    let splitIdx = remaining.lastIndexOf('\n', maxChunkLength);
    if (splitIdx === -1 || splitIdx < Math.floor(maxChunkLength / 2)) {
      // Try finding space break
      splitIdx = remaining.lastIndexOf(' ', maxChunkLength);
    }
    if (splitIdx === -1 || splitIdx < Math.floor(maxChunkLength / 2)) {
      // Hard break at maxChunkLength
      splitIdx = maxChunkLength;
    }

    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }

  return chunks;
}
