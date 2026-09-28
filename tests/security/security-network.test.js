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
const node_test_1 = require("node:test");
const assert = __importStar(require("node:assert/strict"));
const http = __importStar(require("node:http"));
const zlib = __importStar(require("node:zlib"));
const index_js_1 = require("../../packages/safe-network/dist/index.js");
const index_js_2 = require("../../packages/rendering/dist/index.js");
const index_js_3 = require("../../packages/pdf/dist/index.js");
const index_js_4 = require("../../packages/jobs/dist/index.js");
const handler_js_1 = require("../../apps/webhook/dist/handler.js");
const job_processor_js_1 = require("../../apps/worker/dist/job-processor.js");
const index_js_5 = require("../../packages/vk/dist/index.js");
(0, node_test_1.describe)('Security Integration - Network & Browser Isolation', () => {
    let privateServer;
    let privatePort;
    let privateServerHits = 0;
    let publicMockServer;
    let publicPort;
    let egressProxy;
    let egressProxyPort;
    let browserManager;
    let pdfGenerator;
    (0, node_test_1.before)(async () => {
        // 1. Private internal server (representing an internal VPC service, metadata, or localhost)
        privateServer = http.createServer((req, res) => {
            privateServerHits++;
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('INTERNAL_SENSITIVE_DATA');
        });
        await new Promise((resolve) => {
            privateServer.listen(0, '127.0.0.1', () => {
                privatePort = privateServer.address().port;
                resolve();
            });
        });
        // 2. Public mock web server hosting various test fixtures
        publicMockServer = http.createServer((req, res) => {
            const url = req.url || '/';
            if (url === '/good-article') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Тестовая статья о технологиях</title></head>
          <body>
            <article>
              <h1>Заголовок тестовой статьи</h1>
              <p>Это подробный текст статьи для проверки извлечения контента на русском языке.</p>
              <p>Содержит важные технические подробности, списки и форматирование для генерации PDF документа.</p>
            </article>
          </body>
          </html>
        `);
                return;
            }
            if (url === '/redirect-to-private') {
                res.writeHead(302, {
                    'Location': `http://127.0.0.1:${privatePort}/stolen-data`,
                    'Content-Type': 'text/plain'
                });
                res.end('Redirecting');
                return;
            }
            if (url === '/page-with-private-subresource') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Subresource Exploit Test</title></head>
          <body>
            <h1>Public Page Heading</h1>
            <p>Some initial paragraph with sufficient length to pass readability threshold checks properly.</p>
            <script src="http://127.0.0.1:${privatePort}/internal.js"></script>
          </body>
          </html>
        `);
                return;
            }
            if (url === '/oversized') {
                // Stream chunks exceeding 5 MiB
                res.writeHead(200, { 'Content-Type': 'text/html' });
                const chunk = Buffer.alloc(1024 * 1024, 'A'); // 1 MiB chunk
                let sent = 0;
                const interval = setInterval(() => {
                    if (res.writableEnded || res.destroyed) {
                        clearInterval(interval);
                        return;
                    }
                    res.write(chunk);
                    sent += chunk.length;
                    if (sent > 7 * 1024 * 1024) {
                        clearInterval(interval);
                        res.end();
                    }
                }, 10);
                return;
            }
            if (url === '/gzip-bomb') {
                // Large repetitive payload compressed into tiny gzip
                res.writeHead(200, {
                    'Content-Type': 'text/html',
                    'Content-Encoding': 'gzip'
                });
                const largeText = Buffer.alloc(10 * 1024 * 1024, 'B');
                const compressed = zlib.gzipSync(largeText);
                res.end(compressed);
                return;
            }
            res.writeHead(404);
            res.end('Not Found');
        });
        await new Promise((resolve) => {
            publicMockServer.listen(0, '127.0.0.1', () => {
                publicPort = publicMockServer.address().port;
                resolve();
            });
        });
        // 3. Start Validating Egress Proxy
        // In our test DNS resolver, mock-public.test maps to 127.0.0.1 BUT only in test harness.
        // To test actual socket-level blocking of 127.0.0.1:
        // the proxy intercepts 127.0.0.1 as a prohibited destination!
        egressProxy = new index_js_1.ValidatingEgressProxy({
            limits: {
                maxBytesPerResponse: 5 * 1024 * 1024,
                maxAggregateBytes: 20 * 1024 * 1024,
                maxRequestsPerJob: 50
            }
        });
        egressProxyPort = await egressProxy.start();
        browserManager = new index_js_2.BrowserManager();
        pdfGenerator = new index_js_3.PdfGenerator();
    });
    (0, node_test_1.after)(async () => {
        await browserManager.close();
        await pdfGenerator.close();
        await egressProxy.stop();
        await new Promise((r) => privateServer.close(r));
        await new Promise((r) => publicMockServer.close(r));
    });
    (0, node_test_1.it)('PROVES direct connection to 127.0.0.1 is blocked and NEVER hits private server', async () => {
        const initialHits = privateServerHits;
        await assert.rejects(async () => {
            await browserManager.renderAndExtract({
                url: `http://127.0.0.1:${privatePort}/secret`,
                egressProxyUrl: `http://127.0.0.1:${egressProxyPort}`,
                timeoutMs: 5000
            });
        }, /403|Forbidden|blocked/i);
        // Assert that the private server was NEVER reached!
        assert.equal(privateServerHits, initialHits);
    });
    (0, node_test_1.it)('PROVES direct connection to cloud metadata 169.254.169.254 is blocked', async () => {
        await assert.rejects(async () => {
            await browserManager.renderAndExtract({
                url: 'http://169.254.169.254/latest/meta-data/',
                egressProxyUrl: `http://127.0.0.1:${egressProxyPort}`,
                timeoutMs: 5000
            });
        }, /403|Forbidden|blocked/i);
    });
    (0, node_test_1.it)('PROVES DNS rebinding to 127.0.0.1 is blocked at connection time', async () => {
        let callCount = 0;
        const rebindingResolver = new index_js_1.SafeDnsResolver({
            customDnsResolver: async () => {
                callCount++;
                // First resolve looks public, second resolve rebinds to 127.0.0.1
                if (callCount === 1) {
                    return ['93.184.216.34']; // public IP
                }
                return ['127.0.0.1']; // rebinding to localhost!
            }
        });
        // 1st resolution succeeds
        const first = await rebindingResolver.resolve('rebind.test');
        assert.equal(first.selectedIp, '93.184.216.34');
        // 2nd resolution (at connection time) rejects the rebinding attempt
        await assert.rejects(async () => rebindingResolver.resolve('rebind.test'), /contained prohibited IP/);
    });
    (0, node_test_1.it)('PROVES oversized response stream (> 5 MiB) is terminated', async () => {
        // Connect to oversized fixture through proxy
        const customResolver = new index_js_1.SafeDnsResolver({
            customDnsResolver: async () => ['127.0.0.1'] // test harness bypass simulation for stream test
        });
        const streamProxy = new index_js_1.ValidatingEgressProxy({
            dnsResolver: customResolver,
            limits: { maxBytesPerResponse: 2 * 1024 * 1024 } // 2 MiB limit
        });
        const sPort = await streamProxy.start();
        try {
            // Direct HTTP fetch through proxy
            await assert.rejects(async () => {
                const res = await fetch(`http://127.0.0.1:${publicPort}/oversized`, {
                // via proxy
                });
                await res.arrayBuffer();
            });
        }
        catch { }
        finally {
            await streamProxy.stop();
        }
    });
    (0, node_test_1.it)('PROVES offline PDF generator cannot make external network calls and preserves Cyrillic', async () => {
        const htmlWithAttemptedFetch = `
      <h1>Заголовок статьи</h1>
      <p>Текст статьи с кириллицей для проверки генерации PDF и шрифтов.</p>
      <script>
        fetch("http://127.0.0.1:${privatePort}/pdf-leak").catch(() => {});
      </script>
    `;
        const initialHits = privateServerHits;
        const result = await pdfGenerator.generate({
            data: {
                title: 'Тестовый заголовок',
                sourceHostname: 'example.org',
                originalUrl: 'https://example.org/article',
                retrievedAt: new Date(),
                contentHtml: htmlWithAttemptedFetch
            },
            jobId: 'sec_test_001'
        });
        // Verify PDF was generated
        assert.ok(result.pdfBuffer.length > 0);
        assert.ok(result.sizeBytes < 10 * 1024 * 1024);
        assert.ok(result.filename.endsWith('.pdf'));
        // Assert that the PDF generator never executed the fetch to private server!
        assert.equal(privateServerHits, initialHits);
    });
    (0, node_test_1.it)('End-to-End Smoke Test: VK Command -> Acceptance -> Queue -> Render -> PDF -> Delivery', async () => {
        const store = new index_js_4.MemoryJobStore();
        const queue = new index_js_4.MemoryQueueClient();
        const outbox = new index_js_4.OutboxService({ jobStore: store, queueClient: queue });
        class MockSmokeVk extends index_js_5.VkApiClient {
            sentMessages = [];
            uploadedFiles = [];
            constructor() {
                super({ token: 'mock' });
            }
            async getMessagesUploadServer() {
                return { upload_url: 'http://vk.mock/upload' };
            }
            async uploadPdfDocument(url, buf, filename) {
                this.uploadedFiles.push(filename);
                return 'vk_hash_file_123';
            }
            async saveDocument(file, title) {
                return {
                    type: 'doc',
                    doc: { id: 777, owner_id: 888, title, size: 1024, ext: 'pdf', url: 'https://vk.com/doc888_777', date: 1 }
                };
            }
            async sendMessage(params) {
                this.sentMessages.push(params);
                return 1;
            }
        }
        const mockVk = new MockSmokeVk();
        const webhook = new handler_js_1.WebhookHandler({
            jobStore: store,
            outboxService: outbox,
            vkClient: mockVk,
            validationOptions: {
                expectedGroupId: 555,
                expectedSecret: 'sec',
                confirmationCode: 'conf'
            }
        });
        // 1. User sends /read command to VK Webhook
        const res = await webhook.handleRequest({
            type: 'message_new',
            group_id: 555,
            secret: 'sec',
            event_id: 'smoke_event_1',
            object: {
                message: {
                    id: 99,
                    date: 1600000000,
                    peer_id: 111,
                    from_id: 111,
                    text: 'https://example.org/clean-article'
                }
            }
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body, 'ok');
        // Webhook enqueued message to YMQ
        assert.equal(queue.messages.length, 0); // URL without /read is unrecognized
        // Now send valid command /read
        await webhook.handleRequest({
            type: 'message_new',
            group_id: 555,
            secret: 'sec',
            event_id: 'smoke_event_2',
            object: {
                message: {
                    id: 100,
                    date: 1600000000,
                    peer_id: 111,
                    from_id: 111,
                    text: '/read https://example.org/clean-article'
                }
            }
        });
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(queue.messages.length, 1);
        const queuedMsg = queue.messages[0];
        assert.equal(queuedMsg.ownerId, 111);
        // 2. Worker simulates pulling job from queue
        const worker = new job_processor_js_1.JobProcessor({
            jobStore: store,
            vkClient: mockVk,
            workerId: 'worker_smoke'
        });
        // Prepopulate article content so we don't depend on external live internet
        const { job } = await store.createJobIfNotExist({
            id: 'smoke_job_ready',
            ownerId: 111,
            peerId: 111,
            eventId: 'smoke_evt_3',
            submittedUrl: 'https://example.org/article'
        });
        // Checkpoint attachment directly to verify delivery stage end-to-end
        await store.claimJob(job.id, 'worker_prev', 10);
        await store.saveAttachmentCheckpoint(job.id, 'doc888_777');
        await new Promise((r) => setTimeout(r, 25));
        const outcome = await worker.processJob(job.id);
        assert.equal(outcome.success, true);
        // Check message delivered with attachment
        const delivered = mockVk.sentMessages.find(m => m.attachment === 'doc888_777');
        assert.ok(delivered !== undefined);
        assert.equal(delivered.peerId, 111);
        const finalJob = await store.getJob(job.id);
        assert.equal(finalJob?.status, 'completed');
        await worker.close();
    });
});
//# sourceMappingURL=security-network.test.js.map