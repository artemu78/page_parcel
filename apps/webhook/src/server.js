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
exports.WebhookServer = void 0;
const http = __importStar(require("node:http"));
const observability_1 = require("@readable-web/observability");
class WebhookServer {
    server;
    port;
    handler;
    logger;
    maxBodyBytes;
    constructor(options) {
        this.port = options.port ?? (Number.parseInt(process.env.PORT || '8080', 10));
        this.handler = options.handler;
        this.logger = (options.logger ?? observability_1.defaultLogger).child({ component: 'WebhookServer' });
        this.maxBodyBytes = options.maxBodyBytes ?? 100 * 1024; // 100 KB limit
        this.server = http.createServer((req, res) => this.handleRequest(req, res));
    }
    getPort() {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
            return addr.port;
        }
        return this.port;
    }
    async start() {
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
    async stop() {
        return new Promise((resolve, reject) => {
            this.server.close((err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    async handleRequest(req, res) {
        const url = req.url || '/';
        const method = req.method || 'GET';
        if (method === 'GET' && (url === '/healthz' || url === '/readyz')) {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
            return;
        }
        if (method === 'GET' && url === '/metrics') {
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
            res.end(observability_1.metrics.toPrometheusText());
            return;
        }
        if (method === 'POST' && (url === '/vk/callback' || url === '/')) {
            // Read body with bounded size check
            const chunks = [];
            let totalBytes = 0;
            req.on('data', (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > this.maxBodyBytes) {
                    req.destroy();
                    res.writeHead(413, { 'Content-Type': 'text/plain' });
                    res.end('Payload Too Large');
                }
                else {
                    chunks.push(chunk);
                }
            });
            req.on('end', async () => {
                try {
                    const bodyStr = Buffer.concat(chunks).toString('utf-8');
                    let bodyJson;
                    try {
                        bodyJson = JSON.parse(bodyStr);
                    }
                    catch {
                        this.logger.warn('Invalid request JSON');
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        res.end('Bad Request');
                        return;
                    }
                    const result = await this.handler.handleRequest(bodyJson);
                    res.writeHead(result.statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end(result.body);
                }
                catch (err) {
                    this.logger.exception(err, 'Error processing webhook request');
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Bad Request');
                }
            });
            req.on('error', (err) => {
                this.logger.exception(err, 'Incoming connection');
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
}
exports.WebhookServer = WebhookServer;
//# sourceMappingURL=server.js.map