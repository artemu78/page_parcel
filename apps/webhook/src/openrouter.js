"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenRouterClient = void 0;
exports.splitMessage = splitMessage;
const node_https_1 = __importDefault(require("node:https"));
const node_http_1 = __importDefault(require("node:http"));
const node_url_1 = require("node:url");
const https_proxy_agent_1 = require("https-proxy-agent");
const observability_1 = require("@readable-web/observability");
class OpenRouterClient {
    apiKey;
    baseUrl;
    defaultModel;
    proxyUrl;
    timeoutMs;
    logger;
    constructor(options) {
        this.apiKey = options.apiKey;
        this.baseUrl = (options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
        this.defaultModel = options.defaultModel ?? 'google/gemini-2.5-flash';
        this.proxyUrl = options.proxyUrl ?? process.env.OPENROUTER_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.https_proxy ?? process.env.http_proxy;
        this.timeoutMs = options.timeoutMs ?? 60000;
        this.logger = (options.logger ?? observability_1.defaultLogger).child({ component: 'OpenRouterClient' });
    }
    async complete(params) {
        const model = params.model || this.defaultModel;
        const effectiveBaseUrl = (params.baseUrl || this.baseUrl).replace(/\/+$/, '');
        const targetUrl = new node_url_1.URL(`${effectiveBaseUrl}/chat/completions`);
        const messages = [];
        if (params.systemPrompt) {
            messages.push({ role: 'system', content: params.systemPrompt });
        }
        messages.push({ role: 'user', content: params.prompt });
        const payload = JSON.stringify({
            model,
            messages,
            ...(params.maxTokens ? { max_tokens: params.maxTokens } : {})
        });
        const headers = {
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
        const agent = (hasProxy && !isLoopback) ? new https_proxy_agent_1.HttpsProxyAgent(effectiveProxy) : undefined;
        return new Promise((resolve, reject) => {
            const isHttps = targetUrl.protocol === 'https:';
            const requestFn = isHttps ? node_https_1.default.request : node_http_1.default.request;
            const req = requestFn(targetUrl, {
                method: 'POST',
                headers,
                agent,
                timeout: this.timeoutMs
            }, (res) => {
                this.logger.info('OpenRouter HTTP response', { httpStatus: res.statusCode });
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                        return reject(new observability_1.UpstreamResponseError(`OpenRouter API error (HTTP ${res.statusCode})`, 'OpenRouter', res.statusCode));
                    }
                    try {
                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.message?.content;
                        if (typeof content !== 'string') {
                            return reject(new observability_1.UpstreamResponseError('OpenRouter response did not contain message content', 'OpenRouter', res.statusCode ?? 200));
                        }
                        resolve(content.trim());
                    }
                    catch (err) {
                        reject(new observability_1.UpstreamResponseError('Failed to parse OpenRouter response', 'OpenRouter', res.statusCode ?? 200));
                    }
                });
            });
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
exports.OpenRouterClient = OpenRouterClient;
/**
 * Splits a text into chunks not exceeding maxChunkLength characters (default 4000 for VK API 4096 character limit).
 */
function splitMessage(text, maxChunkLength = 4000) {
    if (text.length <= maxChunkLength) {
        return [text];
    }
    const chunks = [];
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
//# sourceMappingURL=openrouter.js.map