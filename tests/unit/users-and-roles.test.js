"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../../packages/jobs/dist/index.js");
const handler_js_1 = require("../../apps/webhook/dist/handler.js");
(0, node_test_1.describe)('Users and Roles Store Operations', () => {
    (0, node_test_1.it)('creates and tracks user access metrics in store', async () => {
        const store = new index_js_1.MemoryJobStore();
        const userId = 100200300;
        // 1. Initial access creates user record
        const user1 = await store.upsertUserAccess(userId, `https://vk.com/id${userId}`);
        strict_1.default.equal(user1.id, userId);
        strict_1.default.equal(user1.requestsCount, 1);
        strict_1.default.equal(user1.status, 0); // Enabled
        strict_1.default.equal(user1.profileLink, `https://vk.com/id${userId}`);
        strict_1.default.ok(user1.createdAt);
        strict_1.default.ok(user1.lastAccess);
        // 2. Second access increments request count and updates last access
        const user2 = await store.upsertUserAccess(userId);
        strict_1.default.equal(user2.requestsCount, 2);
        strict_1.default.equal(user2.createdAt, user1.createdAt);
        // 3. Retrieve user
        const fetched = await store.getUser(userId);
        strict_1.default.ok(fetched);
        strict_1.default.equal(fetched.requestsCount, 2);
        strict_1.default.equal(fetched.status, 0);
    });
    (0, node_test_1.it)('manages user roles correctly', async () => {
        const store = new index_js_1.MemoryJobStore();
        const userId = 500600;
        // 1. Initially no roles
        const initialRoles = await store.getUserRoles(userId);
        strict_1.default.deepEqual(initialRoles, []);
        // 2. Add roles (1 = Admin, 2 = Moderator)
        await store.addUserRole(userId, 1);
        await store.addUserRole(userId, 2);
        // Duplicate role addition should be idempotent
        await store.addUserRole(userId, 1);
        const rolesAfterAdd = await store.getUserRoles(userId);
        strict_1.default.deepEqual(rolesAfterAdd.sort(), [1, 2]);
        // 3. Remove a role
        await store.removeUserRole(userId, 2);
        const rolesAfterRemove = await store.getUserRoles(userId);
        strict_1.default.deepEqual(rolesAfterRemove, [1]);
        // 4. Query users by role (1 = Admin, 2 = ErrorListeners)
        await store.addUserRole(700800, 2);
        const errorListeners = await store.getUsersByRole(2);
        strict_1.default.deepEqual(errorListeners, [700800]);
        const adminUsers = await store.getUsersByRole(1);
        strict_1.default.deepEqual(adminUsers, [userId]);
    });
    (0, node_test_1.it)('webhook blocks requests from users with status 1 (blocked)', async () => {
        const store = new index_js_1.MemoryJobStore();
        const queue = new index_js_1.MemoryQueueClient();
        const outbox = new index_js_1.OutboxService({ jobStore: store, queueClient: queue });
        const sentReplies = [];
        const mockVk = {
            sendMessage: async (params) => {
                sentReplies.push({ peerId: params.peerId, message: params.message });
                return 1;
            }
        };
        const webhook = new handler_js_1.WebhookHandler({
            jobStore: store,
            outboxService: outbox,
            vkClient: mockVk,
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
        strict_1.default.equal(res.statusCode, 200);
        // Wait microtask for async message handling
        await new Promise((r) => setTimeout(r, 50));
        // Verify error reply was sent indicating the user is blocked
        strict_1.default.equal(sentReplies.length, 1);
        strict_1.default.ok(sentReplies[0].message.includes('заблокирован'));
        // Verify NO job was created in the queue
        strict_1.default.equal(queue.messages.length, 0);
    });
});
//# sourceMappingURL=users-and-roles.test.js.map