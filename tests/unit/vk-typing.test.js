"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_js_1 = require("../../packages/vk/dist/index.js");
const index_js_2 = require("../../packages/observability/dist/index.js");
(0, node_test_1.test)('typing uses messages.setActivity and the community token without sending a message', async () => {
    const original = globalThis.fetch;
    const requests = [];
    globalThis.fetch = (async (url, init) => {
        requests.push({ url: String(url), params: new URLSearchParams(String(init?.body)) });
        return new Response(JSON.stringify({ response: 1 }));
    });
    try {
        const client = new index_js_1.VkApiClient({ token: 'test-community-token' });
        await client.setTyping(42);
        strict_1.default.equal(requests.length, 1);
        strict_1.default.equal(requests[0].url, 'https://api.vk.com/method/messages.setActivity');
        strict_1.default.deepEqual(Object.fromEntries(requests[0].params), {
            peer_id: '42', type: 'typing', v: '5.199', access_token: 'test-community-token'
        });
        globalThis.fetch = (async () => new Response('{}', { status: 403 }));
        await strict_1.default.rejects(client.setTyping(42), error => error instanceof index_js_2.UpstreamResponseError && error.statusCode === 403);
    }
    finally {
        globalThis.fetch = original;
    }
});
//# sourceMappingURL=vk-typing.test.js.map