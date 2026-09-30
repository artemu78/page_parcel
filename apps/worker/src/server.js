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
exports.WorkerServer = void 0;
const http = __importStar(require("node:http"));
const observability_1 = require("@readable-web/observability");
class WorkerServer {
    server;
    port;
    processor;
    logger;
    triggerSecret;
    constructor(options) {
        this.port = options.port ?? (Number.parseInt(process.env.PORT || process.env.WORKER_PORT || '8080', 10));
        this.processor = options.processor;
        this.logger = (options.logger ?? observability_1.defaultLogger).child({ component: 'WorkerServer' });
        this.triggerSecret = options.triggerSecret;
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
                this.logger.info(`Worker Server listening on port ${port}`);
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
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
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
                    this.logger.info(`Received trigger payload: ${bodyStr.slice(0, 500)}`);
                    let jobIds = [];
                    // 1. Check messages array (standard YMQ trigger)
                    if (Array.isArray(bodyJson?.messages) && bodyJson.messages.length > 0) {
                        for (const msg of bodyJson.messages) {
                            const rawBody = msg?.details?.body ?? msg?.details?.message?.body ?? msg?.body ?? msg?.details?.message;
                            if (rawBody) {
                                if (typeof rawBody === 'object' && rawBody.jobId) {
                                    jobIds.push(rawBody.jobId);
                                }
                                else if (typeof rawBody === 'string') {
                                    try {
                                        const parsedMsg = JSON.parse(rawBody);
                                        if (parsedMsg.jobId)
                                            jobIds.push(parsedMsg.jobId);
                                    }
                                    catch {
                                        // Try base64
                                        try {
                                            const decoded = Buffer.from(rawBody, 'base64').toString('utf-8');
                                            const parsed = JSON.parse(decoded);
                                            if (parsed.jobId)
                                                jobIds.push(parsed.jobId);
                                        }
                                        catch {
                                            if (rawBody.startsWith('job_'))
                                                jobIds.push(rawBody);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    else if (bodyJson?.jobId) {
                        jobIds.push(bodyJson.jobId);
                    }
                    // 2. Fallback: extract any job ID matching pattern job_<timestamp>_<hash>
                    if (jobIds.length === 0) {
                        const matches = bodyStr.match(/job_\d+_[a-z0-9]+/g);
                        if (matches && matches.length > 0) {
                            jobIds = Array.from(new Set(matches));
                            this.logger.info(`Extracted job IDs via pattern match: ${jobIds.join(', ')}`);
                        }
                    }
                    if (jobIds.length === 0) {
                        this.logger.warn(`Trigger payload contained no recognized job IDs: ${bodyStr}`);
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
                    await (0, observability_1.flushExceptionReports)();
                    if (hasRetryableFailure) {
                        // Return 500 so YMQ trigger does NOT ack and retries after visibility timeout
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Retryable processing error');
                    }
                    else {
                        // Return 200 OK so YMQ trigger deletes message
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'ok', processed: jobIds.length }));
                    }
                }
                catch (err) {
                    this.logger.exception(err, 'Error processing trigger payload');
                    await (0, observability_1.flushExceptionReports)();
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
exports.WorkerServer = WorkerServer;
//# sourceMappingURL=server.js.map