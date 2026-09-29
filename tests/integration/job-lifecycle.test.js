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
const index_js_1 = require("../../packages/jobs/dist/index.js");
const handler_js_1 = require("../../apps/webhook/dist/handler.js");
const job_processor_js_1 = require("../../apps/worker/dist/job-processor.js");
const index_js_2 = require("../../packages/vk/dist/index.js");
class MockVkClient extends index_js_2.VkApiClient {
    sentMessages = [];
    uploadCalls = 0;
    saveCalls = 0;
    failUpload = false;
    failSend = false;
    constructor() {
        super({ token: 'mock_token' });
    }
    async getMessagesUploadServer(peerId) {
        return { upload_url: 'http://mock-upload.vk.test/upload' };
    }
    async uploadPdfDocument(uploadUrl, pdfBuffer, filename) {
        this.uploadCalls++;
        if (this.failUpload) {
            throw new Error('VK API upload server 500 error');
        }
        return 'mock_uploaded_file_hash_123';
    }
    async saveDocument(file, title) {
        this.saveCalls++;
        return {
            type: 'doc',
            doc: {
                id: 998877,
                owner_id: 12345,
                title,
                size: 5000,
                ext: 'pdf',
                url: 'https://vk.com/doc12345_998877',
                date: 1600000000
            }
        };
    }
    async sendMessage(params) {
        if (this.failSend) {
            throw new Error('VK API network timeout');
        }
        this.sentMessages.push({ ...params });
        return this.sentMessages.length;
    }
}
(0, node_test_1.describe)('Integration - Job Lifecycle and Recovery', () => {
    let store;
    let queue;
    let outbox;
    let mockVk;
    let webhook;
    (0, node_test_1.beforeEach)(() => {
        store = new index_js_1.MemoryJobStore();
        queue = new index_js_1.MemoryQueueClient();
        outbox = new index_js_1.OutboxService({ jobStore: store, queueClient: queue });
        mockVk = new MockVkClient();
        webhook = new handler_js_1.WebhookHandler({
            jobStore: store,
            outboxService: outbox,
            vkClient: mockVk,
            validationOptions: {
                expectedGroupId: 12345,
                expectedSecret: 'secret_123',
                confirmationCode: 'code_456'
            }
        });
    });
    (0, node_test_1.it)('durably accepts /read command, enqueues to queue, and acknowledges VK', async () => {
        const callbackPayload = {
            type: 'message_new',
            group_id: 12345,
            secret: 'secret_123',
            event_id: 'evt_100',
            object: {
                message: {
                    id: 1,
                    date: 1600000000,
                    peer_id: 200,
                    from_id: 200,
                    text: '/read https://example.org/valid-article'
                }
            }
        };
        const res = await webhook.handleRequest(callbackPayload);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body, 'ok');
        // Wait microtask for async message handling
        await new Promise((r) => setTimeout(r, 50));
        // Verify job in store
        assert.equal(queue.messages.length, 1);
        const queueMsg = queue.messages[0];
        const job = await store.getJob(queueMsg.jobId);
        assert.ok(job !== null);
        assert.equal(job.status, 'queued');
        assert.equal(job.submittedUrl, 'https://example.org/valid-article');
        // Verify preparation message sent with button and text description
        const prepMsg = mockVk.sentMessages.find(m => m.message.includes('Готовим удобную версию'));
        assert.ok(prepMsg !== undefined);
        assert.ok(prepMsg.message.includes(`/status ${job.id}`));
        assert.ok(prepMsg.keyboard !== undefined);
        const keyboard = JSON.parse(prepMsg.keyboard);
        assert.equal(keyboard.inline, true);
        assert.equal(keyboard.buttons[0][0].action.label, '📊 Проверить статус');
        const buttonPayload = JSON.parse(keyboard.buttons[0][0].action.payload);
        assert.deepEqual(buttonPayload, { command: 'status', jobId: job.id });
    });
    (0, node_test_1.it)('responds to status button click event with job status', async () => {
        // 1. Create a job for user 200
        const { job } = await store.createJobIfNotExist({
            ownerId: 200,
            peerId: 200,
            eventId: 'evt_btn_source',
            submittedUrl: 'https://example.org/button-test'
        });
        // 2. User clicks status button, generating a message_new with button payload
        const callbackPayload = {
            type: 'message_new',
            group_id: 12345,
            secret: 'secret_123',
            event_id: 'evt_btn_click_1',
            object: {
                message: {
                    id: 55,
                    date: 1600000010,
                    peer_id: 200,
                    from_id: 200,
                    text: '📊 Проверить статус',
                    payload: JSON.stringify({ command: 'status', jobId: job.id })
                }
            }
        };
        const res = await webhook.handleRequest(callbackPayload);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body, 'ok');
        await new Promise((r) => setTimeout(r, 50));
        // Verify status reply was sent to user
        const statusMsg = mockVk.sentMessages.find(m => m.message.includes(`Статус задания ${job.id}`));
        assert.ok(statusMsg !== undefined);
        assert.ok(statusMsg.message.includes('Состояние: В очереди на обработку'));
    });
    (0, node_test_1.it)('handles duplicate callback events idempotently without double-enqueuing', async () => {
        const callbackPayload = {
            type: 'message_new',
            group_id: 12345,
            secret: 'secret_123',
            event_id: 'evt_dup_100',
            object: {
                message: {
                    id: 2,
                    date: 1600000000,
                    peer_id: 200,
                    from_id: 200,
                    text: '/read https://example.org/article'
                }
            }
        };
        // First delivery
        await webhook.handleRequest(callbackPayload);
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(queue.messages.length, 1);
        // Duplicate delivery
        const res2 = await webhook.handleRequest(callbackPayload);
        assert.equal(res2.statusCode, 200);
        assert.equal(res2.body, 'ok');
        await new Promise((r) => setTimeout(r, 50));
        // Must still have only 1 queue message
        assert.equal(queue.messages.length, 1);
    });
    (0, node_test_1.it)('prevents cross-user status checks', async () => {
        // Create job for user 300
        const { job } = await store.createJobIfNotExist({
            ownerId: 300,
            peerId: 300,
            eventId: 'evt_owner_test',
            submittedUrl: 'https://example.org/owner-test'
        });
        // Attacker (user 400) tries to view status of user 300's job
        const attackPayload = {
            type: 'message_new',
            group_id: 12345,
            secret: 'secret_123',
            event_id: 'evt_attack_1',
            object: {
                message: {
                    id: 5,
                    date: 1600000000,
                    peer_id: 400,
                    from_id: 400,
                    text: `/status ${job.id}`
                }
            }
        };
        await webhook.handleRequest(attackPayload);
        await new Promise((r) => setTimeout(r, 50));
        // Must return access denied message to user 400
        const deniedMsg = mockVk.sentMessages.find(m => m.peerId === 400);
        assert.ok(deniedMsg !== undefined);
        assert.ok(deniedMsg.message.includes('Доступ запрещен'));
    });
    (0, node_test_1.it)('reuses saved VK attachment when retrying message delivery after failure', async () => {
        const { job } = await store.createJobIfNotExist({
            ownerId: 500,
            peerId: 500,
            eventId: 'evt_retry_checkpoint',
            submittedUrl: 'https://example.org/retry-test'
        });
        // Simulate that upload succeeded and checkpointed in store
        await store.claimJob(job.id, 'worker_old', 10);
        await store.saveAttachmentCheckpoint(job.id, 'doc12345_998877');
        // Lease expires
        await new Promise((r) => setTimeout(r, 20));
        const worker = new job_processor_js_1.JobProcessor({
            jobStore: store,
            vkClient: mockVk,
            workerId: 'worker_retry'
        });
        // Simulate delivery
        const outcome = await worker.processJob(job.id);
        // Because attachment was already saved in checkpoint, uploadCalls must NOT increment!
        assert.equal(mockVk.uploadCalls, 0);
        // Verify delivery message was sent with existing attachment
        const deliveredMsg = mockVk.sentMessages.find(m => m.attachment === 'doc12345_998877');
        assert.ok(deliveredMsg !== undefined);
        const completedJob = await store.getJob(job.id);
        assert.equal(completedJob?.status, 'completed');
        await worker.close();
    });
    (0, node_test_1.it)('notifies user on terminal failure and stops retrying', async () => {
        const { job } = await store.createJobIfNotExist({
            ownerId: 600,
            peerId: 600,
            eventId: 'evt_fail_test',
            submittedUrl: 'http://127.0.0.1/private' // Prohibited private URL
        });
        const worker = new job_processor_js_1.JobProcessor({
            jobStore: store,
            vkClient: mockVk,
            workerId: 'worker_fail'
        });
        // Process job with prohibited SSRF URL
        const outcome = await worker.processJob(job.id);
        // Terminal failure should return success: false, retryable: false
        assert.equal(outcome.success, false);
        assert.equal(outcome.retryable, false);
        const failedJob = await store.getJob(job.id);
        assert.equal(failedJob?.status, 'failed');
        assert.equal(failedJob?.failureCategory, 'SSRF_BLOCKED');
        // Verify user received failure notification with job ID
        const failMsg = mockVk.sentMessages.find(m => m.peerId === 600);
        assert.ok(failMsg !== undefined);
        assert.ok(failMsg.message.includes(job.id));
        assert.ok(failMsg.message.includes('Адрес заблокирован'));
        await worker.close();
    });
    (0, node_test_1.it)('sends error logs to users with role 2 (ErrorListeners)', async () => {
        const listenerId1 = 888222;
        const listenerId2 = 777333;
        await store.addUserRole(listenerId1, 2);
        await store.addUserRole(listenerId2, 2);
        const { job } = await store.createJobIfNotExist({
            ownerId: 555000,
            peerId: 555000,
            eventId: 'evt_listener_test',
            submittedUrl: 'http://127.0.0.1/blocked'
        });
        const worker = new job_processor_js_1.JobProcessor({
            jobStore: store,
            vkClient: mockVk,
            workerId: 'worker_listen'
        });
        await worker.processJob(job.id);
        // Verify both listeners received error log messages
        const listener1Msgs = mockVk.sentMessages.filter(m => m.peerId === listenerId1);
        const listener2Msgs = mockVk.sentMessages.filter(m => m.peerId === listenerId2);
        assert.equal(listener1Msgs.length, 1);
        assert.equal(listener2Msgs.length, 1);
        const logMsg = listener1Msgs[0].message;
        assert.ok(logMsg.includes(job.id));
        assert.ok(logMsg.includes('http://127.0.0.1/blocked'));
        assert.ok(logMsg.includes('https://vk.com/id555000'));
        assert.ok(logMsg.includes('403') || logMsg.includes('UPSTREAM_ERROR') || logMsg.includes('SSRF'));
        await worker.close();
    });
    (0, node_test_1.it)('sends article variable and requester link on CONTENT_UNSUPPORTED extraction error', async () => {
        const listenerId = 444333;
        await store.addUserRole(listenerId, 2);
        const { job } = await store.createJobIfNotExist({
            ownerId: 777123,
            peerId: 777123,
            eventId: 'evt_extract_err_test',
            submittedUrl: 'https://example.com/short-article'
        });
        const worker = new job_processor_js_1.JobProcessor({
            jobStore: store,
            vkClient: mockVk,
            workerId: 'worker_extract_fail'
        });
        // Mock renderAndExtract to simulate ContentExtractionError with article
        const mockArticle = {
            title: 'Tiny Test Page',
            byline: 'Test Author',
            textContent: 'Too short',
            length: 9
        };
        const extractionError = new Error('CONTENT_UNSUPPORTED: Could not extract meaningful readable content (extracted text was shorter than 100 characters)');
        extractionError.article = mockArticle;
        worker.browserManager = {
            renderAndExtract: async () => {
                throw extractionError;
            },
            close: async () => { }
        };
        await worker.processJob(job.id);
        const listenerMsgs = mockVk.sentMessages.filter(m => m.peerId === listenerId);
        assert.equal(listenerMsgs.length, 1);
        const logMsg = listenerMsgs[0].message;
        assert.ok(logMsg.includes(job.id));
        assert.ok(logMsg.includes('Could not extract meaningful readable content'));
        assert.ok(logMsg.includes('https://example.com/short-article'));
        assert.ok(logMsg.includes('https://vk.com/id777123'));
        assert.ok(logMsg.includes('Tiny Test Page'));
        assert.ok(logMsg.includes('Too short'));
        await worker.close();
    });
    (0, node_test_1.it)('responds to /version command with service version', async () => {
        process.env.APP_VERSION = 'v1.2.3-test (abc1234)';
        try {
            const payload = {
                type: 'message_new',
                group_id: 12345,
                secret: 'secret_123',
                event_id: 'evt_version_test',
                object: {
                    message: {
                        id: 99,
                        date: 1600000000,
                        peer_id: 200,
                        from_id: 200,
                        text: '/version'
                    }
                }
            };
            const res = await webhook.handleRequest(payload);
            assert.equal(res.statusCode, 200);
            assert.equal(res.body, 'ok');
            await new Promise((r) => setTimeout(r, 50));
            const versionMsg = mockVk.sentMessages.find(m => m.peerId === 200 && m.message.includes('Версия сервиса'));
            assert.ok(versionMsg !== undefined);
            assert.ok(versionMsg.message.includes('v1.2.3-test (abc1234)'));
        }
        finally {
            delete process.env.APP_VERSION;
        }
    });
});
//# sourceMappingURL=job-lifecycle.test.js.map