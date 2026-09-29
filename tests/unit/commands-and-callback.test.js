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
const commands_js_1 = require("../../apps/webhook/dist/commands.js");
const index_js_1 = require("../../packages/vk/dist/index.js");
(0, node_test_1.describe)('Webhook - Command Parser', () => {
    (0, node_test_1.it)('parses /read command with valid URL', () => {
        const res = (0, commands_js_1.parseCommand)('/read https://example.org/article?id=1');
        assert.deepEqual(res, {
            type: 'read',
            url: 'https://example.org/article?id=1'
        });
    });
    (0, node_test_1.it)('parses /status command with jobId', () => {
        const res = (0, commands_js_1.parseCommand)('/status job_12345_abc');
        assert.deepEqual(res, {
            type: 'status',
            jobId: 'job_12345_abc'
        });
    });
    (0, node_test_1.it)('parses status command from button click payload', () => {
        const payload = JSON.stringify({ command: 'status', jobId: 'job_btn_999' });
        const res = (0, commands_js_1.parseCommand)('📊 Проверить статус', payload);
        assert.deepEqual(res, {
            type: 'status',
            jobId: 'job_btn_999'
        });
    });
    (0, node_test_1.it)('parses /help command and synonyms', () => {
        assert.deepEqual((0, commands_js_1.parseCommand)('/help'), { type: 'help' });
        assert.deepEqual((0, commands_js_1.parseCommand)('?'), { type: 'help' });
        assert.deepEqual((0, commands_js_1.parseCommand)('помощь'), { type: 'help' });
    });
    (0, node_test_1.it)('treats unrecognized text properly', () => {
        const res = (0, commands_js_1.parseCommand)('hello world');
        assert.deepEqual(res, {
            type: 'unrecognized',
            rawText: 'hello world'
        });
    });
});
(0, node_test_1.describe)('VK - Keyboard Generator', () => {
    (0, node_test_1.it)('generates valid inline status keyboard with job ID payload', () => {
        const rawJson = (0, index_js_1.createStatusKeyboard)('job_xyz_789');
        const keyboard = JSON.parse(rawJson);
        assert.equal(keyboard.inline, true);
        assert.equal(Array.isArray(keyboard.buttons), true);
        assert.equal(keyboard.buttons.length, 1);
        assert.equal(keyboard.buttons[0].length, 1);
        const button = keyboard.buttons[0][0];
        assert.equal(button.action.type, 'text');
        assert.equal(button.action.label, '📊 Проверить статус');
        assert.equal(button.color, 'primary');
        const payload = JSON.parse(button.action.payload);
        assert.deepEqual(payload, { command: 'status', jobId: 'job_xyz_789' });
    });
});
(0, node_test_1.describe)('VK - Callback API Validator', () => {
    const options = {
        expectedGroupId: 12345,
        expectedSecret: 'secret_code_123',
        confirmationCode: 'confirm_789'
    };
    (0, node_test_1.it)('returns confirmation response for confirmation event', () => {
        const payload = {
            type: 'confirmation',
            group_id: 12345,
            secret: 'secret_code_123'
        };
        const res = (0, index_js_1.validateCallbackPayload)(payload, options);
        assert.equal(res.valid, true);
        if (res.valid) {
            assert.equal(res.isConfirmation, true);
            assert.equal(res.response, 'confirm_789');
        }
    });
    (0, node_test_1.it)('validates message_new event and returns ok response', () => {
        const payload = {
            type: 'message_new',
            group_id: 12345,
            secret: 'secret_code_123',
            event_id: 'evt_001',
            object: {
                message: {
                    id: 10,
                    date: 1600000000,
                    peer_id: 1001,
                    from_id: 1001,
                    text: '/read https://example.org/page'
                }
            }
        };
        const res = (0, index_js_1.validateCallbackPayload)(payload, options);
        assert.equal(res.valid, true);
        if (res.valid) {
            assert.equal(res.isConfirmation, false);
            assert.equal(res.response, 'ok');
            assert.equal((0, index_js_1.isMessageNewEvent)(res.event), true);
        }
    });
    (0, node_test_1.it)('rejects payload with mismatched group_id', () => {
        const payload = {
            type: 'confirmation',
            group_id: 99999,
            secret: 'secret_code_123'
        };
        const res = (0, index_js_1.validateCallbackPayload)(payload, options);
        assert.equal(res.valid, false);
        if (!res.valid) {
            assert.equal(res.statusCode, 403);
        }
    });
    (0, node_test_1.it)('rejects payload with mismatched secret', () => {
        const payload = {
            type: 'confirmation',
            group_id: 12345,
            secret: 'wrong_secret'
        };
        const res = (0, index_js_1.validateCallbackPayload)(payload, options);
        assert.equal(res.valid, false);
        if (!res.valid) {
            assert.equal(res.statusCode, 403);
        }
    });
});
(0, node_test_1.describe)('VK - Deterministic Random ID', () => {
    (0, node_test_1.it)('generates consistent positive 31-bit integer for identical seeds', () => {
        const id1 = (0, index_js_1.generateStableRandomId)('job_123_success');
        const id2 = (0, index_js_1.generateStableRandomId)('job_123_success');
        assert.equal(id1, id2);
        assert.equal(typeof id1, 'number');
        assert.ok(id1 > 0);
        assert.ok(id1 <= 0x7fffffff);
    });
    (0, node_test_1.it)('generates distinct IDs for distinct phases', () => {
        const prepId = (0, index_js_1.generateStableRandomId)('job_123_prep');
        const successId = (0, index_js_1.generateStableRandomId)('job_123_success');
        const failId = (0, index_js_1.generateStableRandomId)('job_123_fail');
        assert.notEqual(prepId, successId);
        assert.notEqual(successId, failId);
        assert.notEqual(prepId, failId);
    });
});
//# sourceMappingURL=commands-and-callback.test.js.map