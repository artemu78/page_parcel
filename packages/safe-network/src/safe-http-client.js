"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeFetch = safeFetch;
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const zlib = __importStar(require("node:zlib"));
const url_validator_js_1 = require("./url-validator.js");
const dns_resolver_js_1 = require("./dns-resolver.js");
const observability_1 = require("@readable-web/observability");
async function safeFetch(initialUrl, options = {}) {
    const maxRedirects = options.maxRedirects ?? 5;
    const maxBytes = options.maxBytes ?? 5 * 1024 * 1024; // 5 MiB
    const timeoutMs = options.timeoutMs ?? 15000;
    const dnsResolver = options.dnsResolver ?? dns_resolver_js_1.defaultDnsResolver;
    const logger = (options.logger ?? observability_1.defaultLogger).child({ component: 'SafeFetch' });
    let currentUrl = initialUrl;
    let redirectsCount = 0;
    while (true) {
        const validated = (0, url_validator_js_1.validateUrlSyntax)(currentUrl);
        // Resolve DNS
        let targetIp;
        if (validated.isDirectIp && validated.directIp) {
            targetIp = validated.directIp;
        }
        else {
            const resolved = await dnsResolver.resolve(validated.hostname);
            targetIp = resolved.selectedIp;
        }
        const isHttps = validated.protocol === 'https:';
        const requestModule = isHttps ? https : http;
        const requestOptions = {
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
        const response = await new Promise((resolve, reject) => {
            const req = requestModule.request(requestOptions, (res) => {
                let stream = res;
                const encoding = res.headers['content-encoding'];
                if (encoding === 'gzip') {
                    stream = res.pipe(zlib.createGunzip());
                }
                else if (encoding === 'deflate') {
                    stream = res.pipe(zlib.createInflate());
                }
                else if (encoding === 'br') {
                    stream = res.pipe(zlib.createBrotliDecompress());
                }
                const chunks = [];
                let totalReceived = 0;
                stream.on('data', (chunk) => {
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
//# sourceMappingURL=safe-http-client.js.map