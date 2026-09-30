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
exports.ValidatingEgressProxy = void 0;
const http = __importStar(require("node:http"));
const net = __importStar(require("node:net"));
const dns_resolver_js_1 = require("./dns-resolver.js");
const url_validator_js_1 = require("./url-validator.js");
const observability_1 = require("@readable-web/observability");
class ValidatingEgressProxy {
    server;
    port;
    host;
    dnsResolver;
    logger;
    maxRequestsPerJob;
    maxBytesPerResponse;
    maxAggregateBytes;
    totalRequests = 0;
    totalBytesTransferred = 0;
    activeSockets = new Set();
    constructor(options = {}) {
        this.port = options.port ?? 0;
        this.host = options.host ?? '127.0.0.1';
        this.dnsResolver = options.dnsResolver ?? dns_resolver_js_1.defaultDnsResolver;
        this.logger = (options.logger ?? observability_1.defaultLogger).child({ component: 'EgressProxy' });
        const envMaxRequests = process.env.MAX_REQUESTS_PER_JOB ? parseInt(process.env.MAX_REQUESTS_PER_JOB, 10) : undefined;
        this.maxRequestsPerJob = options.limits?.maxRequestsPerJob ?? (envMaxRequests && !isNaN(envMaxRequests) ? envMaxRequests : 500);
        this.maxBytesPerResponse = options.limits?.maxBytesPerResponse ?? 5 * 1024 * 1024; // 5 MiB
        this.maxAggregateBytes = options.limits?.maxAggregateBytes ?? 20 * 1024 * 1024; // 20 MiB
        this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));
        this.server.on('connect', (req, clientSocket, head) => this.handleConnect(req, clientSocket, head));
    }
    getPort() {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
            return addr.port;
        }
        return this.port;
    }
    getProxyUrl() {
        return `http://${this.host}:${this.getPort()}`;
    }
    getStats() {
        return {
            totalRequests: this.totalRequests,
            totalBytesTransferred: this.totalBytesTransferred,
            activeConnections: this.activeSockets.size
        };
    }
    async start() {
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
    async stop() {
        for (const socket of this.activeSockets) {
            socket.destroy();
        }
        this.activeSockets.clear();
        return new Promise((resolve, reject) => {
            this.server.close((err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    incrementRequests() {
        this.totalRequests++;
        if (this.totalRequests > this.maxRequestsPerJob) {
            observability_1.metrics.blockedDestinationsTotal.inc({ reason: 'MAX_REQUESTS_EXCEEDED' });
            throw new Error(`Job exceeded maximum allowed request count (${this.maxRequestsPerJob})`);
        }
    }
    trackBytes(bytes, streamBytes) {
        streamBytes.count += bytes;
        this.totalBytesTransferred += bytes;
        if (streamBytes.count > this.maxBytesPerResponse) {
            observability_1.metrics.blockedDestinationsTotal.inc({ reason: 'RESPONSE_SIZE_EXCEEDED' });
            throw new Error(`Response stream exceeded maximum size (${this.maxBytesPerResponse} bytes)`);
        }
        if (this.totalBytesTransferred > this.maxAggregateBytes) {
            observability_1.metrics.blockedDestinationsTotal.inc({ reason: 'AGGREGATE_SIZE_EXCEEDED' });
            throw new Error(`Job exceeded aggregate network transfer limit (${this.maxAggregateBytes} bytes)`);
        }
    }
    // Handle HTTPS CONNECT tunnel
    async handleConnect(req, clientSocket, head) {
        this.activeSockets.add(clientSocket);
        clientSocket.once('close', () => this.activeSockets.delete(clientSocket));
        try {
            this.incrementRequests();
        }
        catch (err) {
            this.logger.warn(`CONNECT rejected due to request limits: ${err.message}`);
            clientSocket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
            clientSocket.destroy();
            return;
        }
        const rawUrl = req.url || '';
        const [targetHost, targetPortStr] = rawUrl.split(':');
        const targetPort = targetPortStr ? Number.parseInt(targetPortStr, 10) : 443;
        if (!targetHost || Number.isNaN(targetPort) || (targetPort !== 443 && targetPort !== 80)) {
            this.logger.warn(`CONNECT rejected: prohibited destination or port: ${rawUrl}`);
            observability_1.metrics.blockedDestinationsTotal.inc({ reason: 'INVALID_PORT' });
            clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            clientSocket.destroy();
            return;
        }
        // Prevalidate target hostname / IP
        try {
            (0, url_validator_js_1.validateUrlSyntax)(`https://${targetHost}:${targetPort}`);
        }
        catch (err) {
            this.logger.warn(`CONNECT rejected by URL syntax/IP rule: ${err.message}`);
            observability_1.metrics.blockedDestinationsTotal.inc({ reason: 'SSRF_SYNTAX_REJECTED' });
            clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            clientSocket.destroy();
            return;
        }
        // Resolve DNS at connection time
        let validatedIp;
        try {
            if (net.isIP(targetHost)) {
                validatedIp = targetHost;
            }
            else {
                const resolved = await this.dnsResolver.resolve(targetHost);
                validatedIp = resolved.selectedIp;
            }
        }
        catch (err) {
            this.logger.warn(`CONNECT rejected by DNS validation: ${err.message}`);
            observability_1.metrics.blockedDestinationsTotal.inc({ reason: 'SSRF_DNS_REJECTED' });
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
            }
            catch (err) {
                this.logger.warn(`CONNECT stream terminated: ${err.message}`);
                upstreamSocket.destroy();
                clientSocket.destroy();
            }
        });
        clientSocket.on('data', (chunk) => {
            upstreamSocket.write(chunk);
        });
        upstreamSocket.on('error', (err) => {
            this.logger.exception(err, 'Proxy upstream socket');
            clientSocket.destroy();
        });
        clientSocket.on('error', (err) => {
            this.logger.exception(err, 'Proxy client socket');
            upstreamSocket.destroy();
        });
        upstreamSocket.on('end', () => clientSocket.end());
        clientSocket.on('end', () => upstreamSocket.end());
    }
    // Handle plain HTTP proxy requests
    async handleHttpRequest(req, res) {
        try {
            this.incrementRequests();
        }
        catch (err) {
            res.writeHead(429, { 'Content-Type': 'text/plain' });
            res.end(err.message);
            return;
        }
        const rawUrl = req.url;
        if (!rawUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing request URL');
            return;
        }
        let parsedUrl;
        try {
            // If it's a relative path in forward proxy, reconstruct from Host header
            parsedUrl = rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
                ? new URL(rawUrl)
                : new URL(`http://${req.headers.host}${rawUrl}`);
        }
        catch (err) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end(`Invalid request URL: ${err.message}`);
            return;
        }
        try {
            (0, url_validator_js_1.validateUrlSyntax)(parsedUrl.toString());
        }
        catch (err) {
            observability_1.metrics.blockedDestinationsTotal.inc({ reason: 'SSRF_SYNTAX_REJECTED' });
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end(`Forbidden destination: ${err.message}`);
            return;
        }
        // Resolve DNS
        let validatedIp;
        try {
            if (net.isIP(parsedUrl.hostname)) {
                validatedIp = parsedUrl.hostname;
            }
            else {
                const resolved = await this.dnsResolver.resolve(parsedUrl.hostname);
                validatedIp = resolved.selectedIp;
            }
        }
        catch (err) {
            observability_1.metrics.blockedDestinationsTotal.inc({ reason: 'SSRF_DNS_REJECTED' });
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end(`Forbidden DNS destination: ${err.message}`);
            return;
        }
        const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : 80;
        const proxyHeaders = { ...req.headers };
        proxyHeaders.host = parsedUrl.host;
        delete proxyHeaders['proxy-connection'];
        const streamBytes = { count: 0 };
        const upstreamReq = http.request({
            host: validatedIp,
            port,
            method: req.method,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: proxyHeaders,
            timeout: 10000
        }, (upstreamRes) => {
            this.logger.info('Article proxy HTTP response', { httpStatus: upstreamRes.statusCode });
            // Forward headers
            res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
            upstreamRes.on('data', (chunk) => {
                try {
                    this.trackBytes(chunk.length, streamBytes);
                    res.write(chunk);
                }
                catch (err) {
                    this.logger.warn(`HTTP stream terminated: ${err.message}`);
                    upstreamReq.destroy();
                    res.destroy();
                }
            });
            upstreamRes.on('end', () => res.end());
        });
        upstreamReq.on('timeout', () => {
            upstreamReq.destroy();
            if (!res.headersSent) {
                res.writeHead(504, { 'Content-Type': 'text/plain' });
                res.end('Gateway Timeout');
            }
        });
        upstreamReq.on('error', (err) => {
            this.logger.exception(err, 'Proxy upstream request');
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Bad Gateway');
            }
        });
        req.pipe(upstreamReq);
    }
}
exports.ValidatingEgressProxy = ValidatingEgressProxy;
//# sourceMappingURL=egress-proxy.js.map