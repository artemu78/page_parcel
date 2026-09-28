import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyIp,
  validateUrlSyntax,
  SafeDnsResolver
} from '../../packages/safe-network/dist/index.js';

describe('Safe Network - IP Classification', () => {
  it('classifies private RFC1918 IPv4 as non-public', () => {
    assert.equal(classifyIp('10.0.0.1').isPublic, false);
    assert.equal(classifyIp('10.254.254.254').isPublic, false);
    assert.equal(classifyIp('172.16.0.1').isPublic, false);
    assert.equal(classifyIp('172.31.255.254').isPublic, false);
    assert.equal(classifyIp('192.168.0.1').isPublic, false);
    assert.equal(classifyIp('192.168.254.254').isPublic, false);
  });

  it('classifies loopback and link-local (cloud metadata) as non-public', () => {
    assert.equal(classifyIp('127.0.0.1').isPublic, false);
    assert.equal(classifyIp('127.123.45.67').isPublic, false);
    // Yandex / AWS / GCP metadata IP
    assert.equal(classifyIp('169.254.169.254').isPublic, false);
    assert.equal(classifyIp('169.254.1.1').isPublic, false);
  });

  it('classifies CGNAT, multicast, broadcast, and reserved as non-public', () => {
    assert.equal(classifyIp('100.64.0.1').isPublic, false); // CGNAT
    assert.equal(classifyIp('0.0.0.0').isPublic, false);
    assert.equal(classifyIp('224.0.0.1').isPublic, false); // Multicast
    assert.equal(classifyIp('240.0.0.1').isPublic, false); // Reserved
    assert.equal(classifyIp('255.255.255.255').isPublic, false);
  });

  it('classifies IPv6 loopback, ULA, link-local, and multicast as non-public', () => {
    assert.equal(classifyIp('::1').isPublic, false); // Loopback
    assert.equal(classifyIp('::').isPublic, false); // Unspecified
    assert.equal(classifyIp('fc00::1').isPublic, false); // ULA
    assert.equal(classifyIp('fd12:3456:789a::1').isPublic, false); // ULA
    assert.equal(classifyIp('fe80::1').isPublic, false); // Link-local
    assert.equal(classifyIp('ff02::1').isPublic, false); // Multicast
  });

  it('classifies IPv4-mapped IPv6 pointing to private or metadata addresses as non-public', () => {
    assert.equal(classifyIp('::ffff:127.0.0.1').isPublic, false);
    assert.equal(classifyIp('::ffff:169.254.169.254').isPublic, false);
    assert.equal(classifyIp('::ffff:10.0.0.1').isPublic, false);
    assert.equal(classifyIp('::ffff:192.168.1.1').isPublic, false);
  });

  it('classifies legitimate public IPs as public', () => {
    assert.equal(classifyIp('93.184.216.34').isPublic, true); // example.com
    assert.equal(classifyIp('8.8.8.8').isPublic, true);
    assert.equal(classifyIp('1.1.1.1').isPublic, true);
    assert.equal(classifyIp('2606:2800:220:1:248:1893:25c8:1946').isPublic, true);
  });
});

describe('Safe Network - URL Syntax and SSRF Prevalidation', () => {
  it('accepts valid http and https URLs on ports 80 and 443', () => {
    const res1 = validateUrlSyntax('https://example.org/article');
    assert.equal(res1.protocol, 'https:');
    assert.equal(res1.port, 443);
    assert.equal(res1.hostname, 'example.org');

    const res2 = validateUrlSyntax('http://example.org:80/docs');
    assert.equal(res2.protocol, 'http:');
    assert.equal(res2.port, 80);
  });

  it('rejects prohibited schemes', () => {
    assert.throws(() => validateUrlSyntax('ftp://example.com/file'), /Prohibited protocol/);
    assert.throws(() => validateUrlSyntax('file:///etc/passwd'), /Prohibited protocol/);
    assert.throws(() => validateUrlSyntax('javascript:alert(1)'), /Prohibited protocol/);
    assert.throws(() => validateUrlSyntax('data:text/html,<h1>test</h1>'), /Prohibited protocol/);
    assert.throws(() => validateUrlSyntax('gopher://example.com'), /Prohibited protocol/);
  });

  it('rejects non-standard ports', () => {
    assert.throws(() => validateUrlSyntax('http://example.com:8080/'), /Prohibited port/);
    assert.throws(() => validateUrlSyntax('https://example.com:8443/'), /Prohibited port/);
    assert.throws(() => validateUrlSyntax('http://example.com:22/'), /Prohibited port/);
    assert.throws(() => validateUrlSyntax('http://example.com:3000/'), /Prohibited port/);
  });

  it('rejects URLs containing username/password credentials', () => {
    assert.throws(() => validateUrlSyntax('https://admin:secret@example.com/'), /embedded credentials/);
    assert.throws(() => validateUrlSyntax('http://user@example.com/'), /embedded credentials/);
  });

  it('rejects local and internal hostnames', () => {
    assert.throws(() => validateUrlSyntax('http://localhost/'), /Prohibited local\/internal hostname/);
    assert.throws(() => validateUrlSyntax('http://service.local/'), /Prohibited local\/internal hostname/);
    assert.throws(() => validateUrlSyntax('http://db.internal/'), /Prohibited local\/internal hostname/);
    assert.throws(() => validateUrlSyntax('http://app.lan/'), /Prohibited local\/internal hostname/);
  });

  it('rejects direct private IPs and hex/numeric IP bypasses in URLs', () => {
    assert.throws(() => validateUrlSyntax('http://127.0.0.1/'), /Prohibited direct IP/);
    assert.throws(() => validateUrlSyntax('http://169.254.169.254/'), /Prohibited direct IP/);
    assert.throws(() => validateUrlSyntax('http://10.0.0.1/'), /Prohibited direct IP/);
    assert.throws(() => validateUrlSyntax('http://0x7f000001/'), /Prohibited/);
    assert.throws(() => validateUrlSyntax('http://2130706433/'), /Prohibited/);
  });
});

describe('Safe Network - Safe DNS Resolver', () => {
  it('resolves safe public domain successfully', async () => {
    const resolver = new SafeDnsResolver({
      customDnsResolver: async () => ['93.184.216.34']
    });

    const res = await resolver.resolve('example.com');
    assert.equal(res.hostname, 'example.com');
    assert.equal(res.selectedIp, '93.184.216.34');
  });

  it('rejects domain resolving to internal/private IP', async () => {
    const resolver = new SafeDnsResolver({
      customDnsResolver: async () => ['127.0.0.1']
    });

    await assert.rejects(
      async () => resolver.resolve('attacker.com'),
      /contained prohibited IP/
    );
  });

  it('rejects domain if any resolved IP is prohibited (dual-homed / split DNS)', async () => {
    const resolver = new SafeDnsResolver({
      customDnsResolver: async () => ['93.184.216.34', '10.0.0.1']
    });

    await assert.rejects(
      async () => resolver.resolve('mixed.com'),
      /contained prohibited IP/
    );
  });
});
