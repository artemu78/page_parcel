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
const index_js_1 = require("../../packages/safe-network/dist/index.js");
(0, node_test_1.describe)('Safe Network - IP Classification', () => {
    (0, node_test_1.it)('classifies private RFC1918 IPv4 as non-public', () => {
        assert.equal((0, index_js_1.classifyIp)('10.0.0.1').isPublic, false);
        assert.equal((0, index_js_1.classifyIp)('10.254.254.254').isPublic, false);
        assert.equal((0, index_js_1.classifyIp)('172.16.0.1').isPublic, false);
        assert.equal((0, index_js_1.classifyIp)('172.31.255.254').isPublic, false);
        assert.equal((0, index_js_1.classifyIp)('192.168.0.1').isPublic, false);
        assert.equal((0, index_js_1.classifyIp)('192.168.254.254').isPublic, false);
    });
    (0, node_test_1.it)('classifies loopback and link-local (cloud metadata) as non-public', () => {
        assert.equal((0, index_js_1.classifyIp)('127.0.0.1').isPublic, false);
        assert.equal((0, index_js_1.classifyIp)('127.123.45.67').isPublic, false);
        // Yandex / AWS / GCP metadata IP
        assert.equal((0, index_js_1.classifyIp)('169.254.169.254').isPublic, false);
        assert.equal((0, index_js_1.classifyIp)('169.254.1.1').isPublic, false);
    });
    (0, node_test_1.it)('classifies CGNAT, multicast, broadcast, and reserved as non-public', () => {
        assert.equal((0, index_js_1.classifyIp)('100.64.0.1').isPublic, false); // CGNAT
        assert.equal((0, index_js_1.classifyIp)('0.0.0.0').isPublic, false);
        assert.equal((0, index_js_1.classifyIp)('224.0.0.1').isPublic, false); // Multicast
        assert.equal((0, index_js_1.classifyIp)('240.0.0.1').isPublic, false); // Reserved
        assert.equal((0, index_js_1.classifyIp)('255.255.255.255').isPublic, false);
    });
    (0, node_test_1.it)('classifies IPv6 loopback, ULA, link-local, and multicast as non-public', () => {
        assert.equal((0, index_js_1.classifyIp)('::1').isPublic, false); // Loopback
        assert.equal((0, index_js_1.classifyIp)('::').isPublic, false); // Unspecified
        assert.equal((0, index_js_1.classifyIp)('fc00::1').isPublic, false); // ULA
        assert.equal((0, index_js_1.classifyIp)('fd12:3456:789a::1').isPublic, false); // ULA
        assert.equal((0, index_js_1.classifyIp)('fe80::1').isPublic, false); // Link-local
        assert.equal((0, index_js_1.classifyIp)('ff02::1').isPublic, false); // Multicast
    });
    (0, node_test_1.it)('classifies IPv4-mapped IPv6 pointing to private or metadata addresses as non-public', () => {
        assert.equal((0, index_js_1.classifyIp)('::ffff:127.0.0.1').isPublic, false);
        assert.equal((0, index_js_1.classifyIp)('::ffff:169.254.169.254').isPublic, false);
        assert.equal((0, index_js_1.classifyIp)('::ffff:10.0.0.1').isPublic, false);
        assert.equal((0, index_js_1.classifyIp)('::ffff:192.168.1.1').isPublic, false);
    });
    (0, node_test_1.it)('classifies legitimate public IPs as public', () => {
        assert.equal((0, index_js_1.classifyIp)('93.184.216.34').isPublic, true); // example.com
        assert.equal((0, index_js_1.classifyIp)('8.8.8.8').isPublic, true);
        assert.equal((0, index_js_1.classifyIp)('1.1.1.1').isPublic, true);
        assert.equal((0, index_js_1.classifyIp)('2606:2800:220:1:248:1893:25c8:1946').isPublic, true);
    });
});
(0, node_test_1.describe)('Safe Network - URL Syntax and SSRF Prevalidation', () => {
    (0, node_test_1.it)('accepts valid http and https URLs on ports 80 and 443', () => {
        const res1 = (0, index_js_1.validateUrlSyntax)('https://example.org/article');
        assert.equal(res1.protocol, 'https:');
        assert.equal(res1.port, 443);
        assert.equal(res1.hostname, 'example.org');
        const res2 = (0, index_js_1.validateUrlSyntax)('http://example.org:80/docs');
        assert.equal(res2.protocol, 'http:');
        assert.equal(res2.port, 80);
    });
    (0, node_test_1.it)('rejects prohibited schemes', () => {
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('ftp://example.com/file'), /Prohibited protocol/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('file:///etc/passwd'), /Prohibited protocol/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('javascript:alert(1)'), /Prohibited protocol/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('data:text/html,<h1>test</h1>'), /Prohibited protocol/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('gopher://example.com'), /Prohibited protocol/);
    });
    (0, node_test_1.it)('rejects non-standard ports', () => {
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://example.com:8080/'), /Prohibited port/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('https://example.com:8443/'), /Prohibited port/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://example.com:22/'), /Prohibited port/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://example.com:3000/'), /Prohibited port/);
    });
    (0, node_test_1.it)('rejects URLs containing username/password credentials', () => {
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('https://admin:secret@example.com/'), /embedded credentials/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://user@example.com/'), /embedded credentials/);
    });
    (0, node_test_1.it)('rejects local and internal hostnames', () => {
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://localhost/'), /Prohibited local\/internal hostname/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://service.local/'), /Prohibited local\/internal hostname/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://db.internal/'), /Prohibited local\/internal hostname/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://app.lan/'), /Prohibited local\/internal hostname/);
    });
    (0, node_test_1.it)('rejects direct private IPs and hex/numeric IP bypasses in URLs', () => {
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://127.0.0.1/'), /Prohibited direct IP/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://169.254.169.254/'), /Prohibited direct IP/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://10.0.0.1/'), /Prohibited direct IP/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://0x7f000001/'), /Prohibited/);
        assert.throws(() => (0, index_js_1.validateUrlSyntax)('http://2130706433/'), /Prohibited/);
    });
});
(0, node_test_1.describe)('Safe Network - Safe DNS Resolver', () => {
    (0, node_test_1.it)('resolves safe public domain successfully', async () => {
        const resolver = new index_js_1.SafeDnsResolver({
            customDnsResolver: async () => ['93.184.216.34']
        });
        const res = await resolver.resolve('example.com');
        assert.equal(res.hostname, 'example.com');
        assert.equal(res.selectedIp, '93.184.216.34');
    });
    (0, node_test_1.it)('rejects domain resolving to internal/private IP', async () => {
        const resolver = new index_js_1.SafeDnsResolver({
            customDnsResolver: async () => ['127.0.0.1']
        });
        await assert.rejects(async () => resolver.resolve('attacker.com'), /contained prohibited IP/);
    });
    (0, node_test_1.it)('rejects domain if any resolved IP is prohibited (dual-homed / split DNS)', async () => {
        const resolver = new index_js_1.SafeDnsResolver({
            customDnsResolver: async () => ['93.184.216.34', '10.0.0.1']
        });
        await assert.rejects(async () => resolver.resolve('mixed.com'), /contained prohibited IP/);
    });
});
//# sourceMappingURL=safe-network.test.js.map