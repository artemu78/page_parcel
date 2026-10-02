"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenRouterClient = void 0;
exports.splitMessage = splitMessage;
const node_crypto_1 = require("node:crypto");
const node_https_1 = __importDefault(require("node:https"));
const node_http_1 = __importDefault(require("node:http"));
const node_url_1 = require("node:url");
const https_proxy_agent_1 = require("https-proxy-agent");
const observability_1 = require("@readable-web/observability");
/** Provider messages may echo prompts. Emit only fixed categories and numeric codes. */
function failureDetails(data) {
    let json;
    try {
        json = JSON.parse(data);
    }
    catch {
        return { responseFormat: 'non_json', failureCategory: 'upstream_rejection' };
    }
    const error = json && typeof json === 'object' ? json.error : undefined;
    const fields = error && typeof error === 'object' ? error : {};
    const message = typeof fields.message === 'string' ? fields.message.toLowerCase() : '';
    const metadata = fields.metadata && typeof fields.metadata === 'object' ? fields.metadata : {};
    let failureCategory = 'upstream_rejection';
    if (/country|region|geographic|geo.block/.test(message))
        failureCategory = 'geo_restriction';
    else if (/api key|unauthorized|authentication/.test(message))
        failureCategory = 'authentication';
    else if (/credit|insufficient funds|payment/.test(message))
        failureCategory = 'credits';
    else if (/rate limit|too many requests/.test(message))
        failureCategory = 'rate_limit';
    else if (/moderation|alignment|flagged/.test(message) || metadata.flagged_input !== undefined || metadata.alignment !== undefined)
        failureCategory = 'content_policy';
    else if (/model.*(?:not found|unavailable)|no endpoints/.test(message))
        failureCategory = 'model_unavailable';
    return { responseFormat: 'json', failureCategory,
        ...(typeof fields.code === 'number' && Number.isSafeInteger(fields.code) ? { providerErrorCode: fields.code } : {}) };
}
function safeResponseId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
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
        messages.push(...(params.history ?? []));
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
        const diagnostics = {
            openRouterRequestId: (0, node_crypto_1.randomUUID)(), model: model.slice(0, 128),
            destinationHost: targetUrl.hostname,
            routing: targetUrl.hostname === 'openrouter.ai' ? 'direct' : 'reverse_proxy',
            forwardProxyUsed: Boolean(agent),
            ...(agent ? { forwardProxyHost: new node_url_1.URL(effectiveProxy).hostname } : {})
        };
        this.logger.info('OpenRouter request', diagnostics);
        const startedAt = Date.now();
        return new Promise((resolve, reject) => {
            const isHttps = targetUrl.protocol === 'https:';
            const requestFn = isHttps ? node_https_1.default.request : node_http_1.default.request;
            const req = requestFn(targetUrl, {
                method: 'POST',
                headers,
                agent,
                timeout: this.timeoutMs
            }, (res) => {
                const responseContext = { ...diagnostics, httpStatus: res.statusCode,
                    upstreamRequestId: safeResponseId(res.headers['x-request-id'] ?? res.headers['request-id']),
                    cloudflareRay: safeResponseId(res.headers['cf-ray']),
                    responseFormat: res.headers['content-type']?.includes('json') ? 'json' : 'non_json' };
                this.logger.info('OpenRouter HTTP response', responseContext);
                let data = '';
                let responseBytes = 0;
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    responseBytes += Buffer.byteLength(chunk);
                    if (responseBytes > 1048576) {
                        this.logger.info('OpenRouter response rejected', { ...responseContext, failureCategory: 'response_too_large', responseBytes });
                        reject(new observability_1.UpstreamResponseError('OpenRouter response exceeded size limit', 'OpenRouter', res.statusCode ?? 200));
                        res.destroy();
                        return;
                    }
                    data += chunk;
                });
                res.on('error', reject);
                res.on('aborted', () => reject(new observability_1.UpstreamResponseError('OpenRouter response interrupted', 'OpenRouter', res.statusCode ?? 200)));
                res.on('end', () => {
                    if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                        this.logger.info('OpenRouter request rejected', { ...responseContext, ...failureDetails(data), responseBytes, durationMs: Date.now() - startedAt });
                        return reject(new observability_1.UpstreamResponseError(`OpenRouter API error (HTTP ${res.statusCode})`, 'OpenRouter', res.statusCode));
                    }
                    try {
                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.message?.content;
                        if (typeof content !== 'string') {
                            this.logger.info('OpenRouter response rejected', { ...responseContext, ...failureDetails(data), failureCategory: 'missing_completion', responseBytes });
                            return reject(new observability_1.UpstreamResponseError('OpenRouter response did not contain message content', 'OpenRouter', res.statusCode ?? 200));
                        }
                        resolve(content.trim());
                    }
                    catch (err) {
                        this.logger.info('OpenRouter response rejected', { ...responseContext, failureCategory: 'invalid_json', responseBytes });
                        reject(new observability_1.UpstreamResponseError('Failed to parse OpenRouter response', 'OpenRouter', res.statusCode ?? 200));
                    }
                });
            });
            req.on('timeout', () => {
                req.destroy(new Error(`OpenRouter request timed out after ${this.timeoutMs}ms`));
            });
            req.on('error', (err) => {
                this.logger.exception(err, 'OpenRouter network request', diagnostics);
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