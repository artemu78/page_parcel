import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryJobStore, MemoryQueueClient, OutboxService } from '../../packages/jobs/dist/index.js';
import { WebhookHandler } from '../../apps/webhook/dist/handler.js';

describe('Users and Roles Store Operations', () => {
  it('creates and tracks user access metrics in store', async () => {
    const store = new MemoryJobStore();
    const userId = 100200300;

    // 1. Initial access creates user record
    const user1 = await store.upsertUserAccess(userId, `https://vk.com/id${userId}`);
    assert.equal(user1.id, userId);
    assert.equal(user1.requestsCount, 1);
    assert.equal(user1.status, 0); // Enabled
    assert.equal(user1.profileLink, `https://vk.com/id${userId}`);
    assert.ok(user1.createdAt);
    assert.ok(user1.lastAccess);

    // 2. Second access increments request count and updates last access
    const user2 = await store.upsertUserAccess(userId);
    assert.equal(user2.requestsCount, 2);
    assert.equal(user2.createdAt, user1.createdAt);

    // 3. Retrieve user
    const fetched = await store.getUser(userId);
    assert.ok(fetched);
    assert.equal(fetched.requestsCount, 2);
    assert.equal(fetched.status, 0);
  });

  it('manages user roles correctly', async () => {
    const store = new MemoryJobStore();
    const userId = 500600;

    // 1. Initially no roles
    const initialRoles = await store.getUserRoles(userId);
    assert.deepEqual(initialRoles, []);

    // 2. Add roles (1 = Admin, 2 = Moderator)
    await store.addUserRole(userId, 1);
    await store.addUserRole(userId, 2);
    // Duplicate role addition should be idempotent
    await store.addUserRole(userId, 1);

    const rolesAfterAdd = await store.getUserRoles(userId);
    assert.deepEqual(rolesAfterAdd.sort(), [1, 2]);

    // 3. Remove a role
    await store.removeUserRole(userId, 2);
    const rolesAfterRemove = await store.getUserRoles(userId);
    assert.deepEqual(rolesAfterRemove, [1]);

    // 4. Query users by role (1 = Admin, 2 = ErrorListeners)
    await store.addUserRole(700800, 2);
    const errorListeners = await store.getUsersByRole(2);
    assert.deepEqual(errorListeners, [700800]);

    const adminUsers = await store.getUsersByRole(1);
    assert.deepEqual(adminUsers, [userId]);
  });

  it('webhook blocks requests from users with status 1 (blocked)', async () => {
    const store = new MemoryJobStore();
    const queue = new MemoryQueueClient();
    const outbox = new OutboxService({ jobStore: store, queueClient: queue });

    const sentReplies: Array<{ peerId: number; message: string }> = [];
    const mockVk = {
      sendMessage: async (params: any) => {
        sentReplies.push({ peerId: params.peerId, message: params.message });
        return 1;
      }
    };

    const webhook = new WebhookHandler({
      jobStore: store,
      outboxService: outbox,
      vkClient: mockVk as any,
      validationOptions: {
        expectedGroupId: 12345,
        expectedSecret: 'sec',
        confirmationCode: 'code'
      }
    });

    const blockedUserId = 999666;
    // Set user as blocked
    await store.upsertUserAccess(blockedUserId);
    await store.setUserStatus(blockedUserId, 1); // Blocked

    const blockedPayload = {
      type: 'message_new',
      group_id: 12345,
      secret: 'sec',
      event_id: 'evt_block_1',
      object: {
        message: {
          id: 10,
          from_id: blockedUserId,
          peer_id: blockedUserId,
          text: '/read https://example.com/article'
        }
      }
    };

    const res = await webhook.handleRequest(blockedPayload);
    assert.equal(res.statusCode, 200);

    // Wait microtask for async message handling
    await new Promise((r) => setTimeout(r, 50));

    // Verify error reply was sent indicating the user is blocked
    assert.equal(sentReplies.length, 1);
    assert.ok(sentReplies[0].message.includes('заблокирован'));

    // Verify NO job was created in the queue
    assert.equal(queue.messages.length, 0);
  });
});
