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
(0, node_test_1.describe)('Jobs - Deduplication and Persistence', () => {
    (0, node_test_1.it)('creates job idempotently on event ID', async () => {
        const store = new index_js_1.MemoryJobStore();
        const res1 = await store.createJobIfNotExist({
            ownerId: 101,
            peerId: 101,
            eventId: 'evt_1001',
            submittedUrl: 'https://example.org/article-1'
        });
        assert.equal(res1.isDuplicate, false);
        assert.equal(res1.job.status, 'accepted');
        assert.equal(res1.job.attempts, 0);
        // Duplicate call with identical event ID
        const res2 = await store.createJobIfNotExist({
            ownerId: 101,
            peerId: 101,
            eventId: 'evt_1001',
            submittedUrl: 'https://example.org/article-1'
        });
        assert.equal(res2.isDuplicate, true);
        assert.equal(res2.job.id, res1.job.id);
    });
});
(0, node_test_1.describe)('Jobs - Leases, Concurrency, and Stale-Worker Protection', () => {
    (0, node_test_1.it)('allows atomic claim for first worker and rejects concurrent claims', async () => {
        const store = new index_js_1.MemoryJobStore();
        const { job } = await store.createJobIfNotExist({
            ownerId: 102,
            peerId: 102,
            eventId: 'evt_1002',
            submittedUrl: 'https://example.org/article-2'
        });
        // Worker 1 claims job
        const claim1 = await store.claimJob(job.id, 'worker_1', 10000); // 10s lease
        assert.ok(claim1 !== null);
        assert.equal(claim1.status, 'rendering');
        assert.equal(claim1.attempts, 1);
        assert.equal(claim1.leaseOwner, 'worker_1');
        // Worker 2 attempts concurrent claim
        const claim2 = await store.claimJob(job.id, 'worker_2', 10000);
        assert.equal(claim2, null); // rejected because lease is active
    });
    (0, node_test_1.it)('allows reclaim after lease expiry', async () => {
        const store = new index_js_1.MemoryJobStore();
        const { job } = await store.createJobIfNotExist({
            ownerId: 103,
            peerId: 103,
            eventId: 'evt_1003',
            submittedUrl: 'https://example.org/article-3'
        });
        // Worker 1 claims with very short lease (10ms)
        await store.claimJob(job.id, 'worker_1', 10);
        // Wait for lease to expire
        await new Promise((r) => setTimeout(r, 25));
        // Worker 2 reclaims expired job
        const claim2 = await store.claimJob(job.id, 'worker_2', 10000);
        assert.ok(claim2 !== null);
        assert.equal(claim2.leaseOwner, 'worker_2');
        assert.equal(claim2.attempts, 2);
    });
    (0, node_test_1.it)('enforces optimistic lock versioning on updates', async () => {
        const store = new index_js_1.MemoryJobStore();
        const { job } = await store.createJobIfNotExist({
            ownerId: 104,
            peerId: 104,
            eventId: 'evt_1004',
            submittedUrl: 'https://example.org/article-4'
        });
        const claimed = await store.claimJob(job.id, 'worker_1', 10000);
        assert.ok(claimed !== null);
        // Update with correct version succeeds
        const updated = await store.updateStatus(job.id, 'rendering', {
            expectedVersion: claimed.version,
            finalUrl: 'https://example.org/article-4-final'
        });
        assert.equal(updated.finalUrl, 'https://example.org/article-4-final');
        // Update with outdated version fails
        await assert.rejects(async () => store.updateStatus(job.id, 'uploading', { expectedVersion: claimed.version }), /Optimistic lock failed/);
    });
    (0, node_test_1.it)('checkpoints VK attachment for delivery retry', async () => {
        const store = new index_js_1.MemoryJobStore();
        const { job } = await store.createJobIfNotExist({
            ownerId: 105,
            peerId: 105,
            eventId: 'evt_1005',
            submittedUrl: 'https://example.org/article-5'
        });
        await store.claimJob(job.id, 'worker_1', 10000);
        const checkpointed = await store.saveAttachmentCheckpoint(job.id, 'doc12345_67890');
        assert.equal(checkpointed.status, 'delivering');
        assert.equal(checkpointed.vkAttachment, 'doc12345_67890');
        // Verification from store
        const retrieved = await store.getJob(job.id);
        assert.equal(retrieved?.vkAttachment, 'doc12345_67890');
    });
});
(0, node_test_1.describe)('Jobs - Rate Limiting', () => {
    (0, node_test_1.it)('enforces atomic sliding window limit per user', async () => {
        const store = new index_js_1.MemoryJobStore();
        const userId = 2001;
        // Limit: 3 requests per 1000ms
        const r1 = await store.checkAndConsumeRateLimit(userId, 3, 1000);
        const r2 = await store.checkAndConsumeRateLimit(userId, 3, 1000);
        const r3 = await store.checkAndConsumeRateLimit(userId, 3, 1000);
        assert.equal(r1.allowed, true);
        assert.equal(r2.allowed, true);
        assert.equal(r3.allowed, true);
        // 4th request exceeds quota
        const r4 = await store.checkAndConsumeRateLimit(userId, 3, 1000);
        assert.equal(r4.allowed, false);
        assert.ok((r4.retryAfterSeconds || 0) > 0);
    });
});
//# sourceMappingURL=jobs-and-leases.test.js.map