import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryJobStore, MemoryQueueClient, OutboxService } from '../../packages/jobs/dist/index.js';
import { WebhookHandler } from '../../apps/webhook/dist/handler.js';
import { JobProcessor } from '../../apps/worker/dist/job-processor.js';
import { VkApiClient } from '../../packages/vk/dist/index.js';

class MockVkClient extends VkApiClient {
  public sentMessages: Array<{
    peerId: number;
    message: string;
    attachment?: string;
    randomId: number;
    keyboard?: string;
  }> = [];
  public uploadCalls = 0;
  public saveCalls = 0;
  public failUpload = false;
  public failSend = false;

  constructor() {
    super({ token: 'mock_token' });
  }

  public override async getMessagesUploadServer(peerId: number) {
    return { upload_url: 'http://mock-upload.vk.test/upload' };
  }

  public override async uploadPdfDocument(uploadUrl: string, pdfBuffer: Buffer, filename: string) {
    this.uploadCalls++;
    if (this.failUpload) {
      throw new Error('VK API upload server 500 error');
    }
    return 'mock_uploaded_file_hash_123';
  }

  public override async saveDocument(file: string, title: string) {
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

  public override async sendMessage(params: {
    peerId: number;
    message: string;
    attachment?: string;
    randomId: number;
    keyboard?: string;
  }) {
    if (this.failSend) {
      throw new Error('VK API network timeout');
    }
    this.sentMessages.push({ ...params });
    return this.sentMessages.length;
  }
}

describe('Integration - Job Lifecycle and Recovery', () => {
  let store: MemoryJobStore;
  let queue: MemoryQueueClient;
  let outbox: OutboxService;
  let mockVk: MockVkClient;
  let webhook: WebhookHandler;

  beforeEach(() => {
    store = new MemoryJobStore();
    queue = new MemoryQueueClient();
    outbox = new OutboxService({ jobStore: store, queueClient: queue });
    mockVk = new MockVkClient();
    webhook = new WebhookHandler({
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

  it('durably accepts /read command, enqueues to queue, and acknowledges VK', async () => {
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

    const keyboard = JSON.parse(prepMsg.keyboard!);
    assert.equal(keyboard.inline, true);
    assert.equal(keyboard.buttons[0][0].action.label, '📊 Проверить статус');
    const buttonPayload = JSON.parse(keyboard.buttons[0][0].action.payload);
    assert.deepEqual(buttonPayload, { command: 'status', jobId: job.id });
  });

  it('responds to status button click event with job status', async () => {
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

  it('handles duplicate callback events idempotently without double-enqueuing', async () => {
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

  it('prevents cross-user status checks', async () => {
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

  it('reuses saved VK attachment when retrying message delivery after failure', async () => {
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

    const worker = new JobProcessor({
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

  it('notifies user on terminal failure and stops retrying', async () => {
    const { job } = await store.createJobIfNotExist({
      ownerId: 600,
      peerId: 600,
      eventId: 'evt_fail_test',
      submittedUrl: 'http://127.0.0.1/private' // Prohibited private URL
    });

    const worker = new JobProcessor({
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
});
