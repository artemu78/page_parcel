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
exports.ipv4ToUint32 = ipv4ToUint32;
exports.matchIpv4Cidr = matchIpv4Cidr;
exports.ipv6ToBigInt = ipv6ToBigInt;
exports.matchIpv6Cidr = matchIpv6Cidr;
exports.classifyIp = classifyIp;
const net = __importStar(require("node:net"));
// Convert IPv4 string to 32-bit unsigned number
function ipv4ToUint32(ip) {
    const parts = ip.split('.').map(p => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) {
        throw new Error(`Invalid IPv4 address format: ${ip}`);
    }
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
// Match IPv4 against CIDR
function matchIpv4Cidr(ipNum, cidrIp, prefixLen) {
    const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
    const cidrNum = ipv4ToUint32(cidrIp);
    return (ipNum & mask) === (cidrNum & mask);
}
// Prohibited IPv4 ranges:
// 0.0.0.0/8 (This host)
// 10.0.0.0/8 (Private RFC1918)
// 100.64.0.0/10 (CGNAT RFC6598)
// 127.0.0.0/8 (Loopback RFC1122)
// 169.254.0.0/16 (Link-local RFC3927 - includes 169.254.169.254 metadata!)
// 172.16.0.0/12 (Private RFC1918)
// 192.0.0.0/24 (IETF Protocol Assignments RFC6890)
// 192.0.2.0/24 (TEST-NET-1 RFC5737)
// 192.88.99.0/24 (6to4 Relay Anycast RFC3068)
// 192.168.0.0/16 (Private RFC1918)
// 198.18.0.0/15 (Benchmarking RFC2544)
// 198.51.100.0/24 (TEST-NET-2 RFC5737)
// 203.0.113.0/24 (TEST-NET-3 RFC5737)
// 224.0.0.0/4 (Multicast RFC5771)
// 240.0.0.0/4 (Reserved / Future Use RFC1112)
// 255.255.255.255/32 (Broadcast)
const IPV4_PROHIBITED_RANGES = [
    { cidr: '0.0.0.0', prefix: 8, name: 'Current network (this host)' },
    { cidr: '10.0.0.0', prefix: 8, name: 'Private RFC 1918' },
    { cidr: '100.64.0.0', prefix: 10, name: 'Shared Address / CGNAT RFC 6598' },
    { cidr: '127.0.0.0', prefix: 8, name: 'Loopback RFC 1122' },
    { cidr: '169.254.0.0', prefix: 16, name: 'Link-Local / Cloud Metadata RFC 3927' },
    { cidr: '172.16.0.0', prefix: 12, name: 'Private RFC 1918' },
    { cidr: '192.0.0.0', prefix: 24, name: 'IETF Protocol Assignments RFC 6890' },
    { cidr: '192.0.2.0', prefix: 24, name: 'Documentation TEST-NET-1 RFC 5737' },
    { cidr: '192.88.99.0', prefix: 24, name: '6to4 Relay Anycast RFC 3068' },
    { cidr: '192.168.0.0', prefix: 16, name: 'Private RFC 1918' },
    { cidr: '198.18.0.0', prefix: 15, name: 'Network Interconnect Benchmark RFC 2544' },
    { cidr: '198.51.100.0', prefix: 24, name: 'Documentation TEST-NET-2 RFC 5737' },
    { cidr: '203.0.113.0', prefix: 24, name: 'Documentation TEST-NET-3 RFC 5737' },
    { cidr: '224.0.0.0', prefix: 4, name: 'Multicast RFC 5771' },
    { cidr: '240.0.0.0', prefix: 4, name: 'Reserved / Future Use RFC 1112' },
    { cidr: '255.255.255.255', prefix: 32, name: 'Limited Broadcast' }
];
// Convert IPv6 address to BigInt
function ipv6ToBigInt(ip) {
    let normalized = ip.toLowerCase();
    // Handle IPv4-mapped IPv6 suffix e.g. ::ffff:192.0.2.1
    const lastColon = normalized.lastIndexOf(':');
    const possibleIpv4 = normalized.substring(lastColon + 1);
    if (possibleIpv4.includes('.')) {
        const ipv4Num = ipv4ToUint32(possibleIpv4);
        const hex1 = ((ipv4Num >>> 16) & 0xffff).toString(16);
        const hex2 = (ipv4Num & 0xffff).toString(16);
        normalized = normalized.substring(0, lastColon + 1) + hex1 + ':' + hex2;
    }
    const parts = normalized.split('::');
    let left = [];
    let right = [];
    if (parts.length > 2) {
        throw new Error(`Invalid IPv6 address format: ${ip}`);
    }
    if (parts.length === 2) {
        left = parts[0] ? parts[0].split(':') : [];
        right = parts[1] ? parts[1].split(':') : [];
        const missing = 8 - (left.length + right.length);
        if (missing < 0) {
            throw new Error(`Invalid IPv6 address length: ${ip}`);
        }
        const middle = Array(missing).fill('0');
        left = [...left, ...middle, ...right];
    }
    else {
        left = normalized.split(':');
        if (left.length !== 8) {
            throw new Error(`Invalid IPv6 address parts count: ${ip}`);
        }
    }
    let result = 0n;
    for (const part of left) {
        const num = BigInt(Number.parseInt(part || '0', 16));
        result = (result << 16n) | num;
    }
    return result;
}
// Match IPv6 against CIDR
function matchIpv6Cidr(ipBigInt, cidrIp, prefixLen) {
    const cidrBigInt = ipv6ToBigInt(cidrIp);
    const shift = BigInt(128 - prefixLen);
    return (ipBigInt >> shift) === (cidrBigInt >> shift);
}
// Prohibited IPv6 ranges:
// ::/128 (Unspecified)
// ::1/128 (Loopback)
// ::ffff:0:0/96 (IPv4-mapped IPv6)
// 64:ff9b::/96 (IPv4/IPv6 translation RFC 6052)
// 100::/64 (Discard-only RFC 6666)
// 2001::/23 (IETF Protocol Assignments)
// 2001:db8::/32 (Documentation RFC 3849)
// 2002::/16 (6to4 RFC 3056)
// fc00::/7 (Unique Local Address RFC 4193 - private)
// fe80::/10 (Link-Local Unicast RFC 4291)
// ff00::/8 (Multicast RFC 4291)
const IPV6_PROHIBITED_RANGES = [
    { cidr: '::', prefix: 128, name: 'Unspecified' },
    { cidr: '::1', prefix: 128, name: 'Loopback' },
    { cidr: '64:ff9b::', prefix: 96, name: 'IPv4/IPv6 Translation RFC 6052' },
    { cidr: '100::', prefix: 64, name: 'Discard-Only RFC 6666' },
    { cidr: '2001::', prefix: 23, name: 'IETF Protocol Assignments' },
    { cidr: '2001:db8::', prefix: 32, name: 'Documentation RFC 3849' },
    { cidr: '2002::', prefix: 16, name: '6to4 RFC 3056' },
    { cidr: 'fc00::', prefix: 7, name: 'Unique Local Address (ULA) RFC 4193' },
    { cidr: 'fe80::', prefix: 10, name: 'Link-Local Unicast RFC 4291' },
    { cidr: 'ff00::', prefix: 8, name: 'Multicast RFC 4291' }
];
function classifyIp(ipAddress) {
    const cleanIp = ipAddress.trim();
    const family = net.isIP(cleanIp);
    if (family === 4) {
        try {
            const ipNum = ipv4ToUint32(cleanIp);
            for (const range of IPV4_PROHIBITED_RANGES) {
                if (matchIpv4Cidr(ipNum, range.cidr, range.prefix)) {
                    return {
                        isPublic: false,
                        ip: cleanIp,
                        version: 4,
                        reason: `IP ${cleanIp} falls in prohibited range ${range.cidr}/${range.prefix} (${range.name})`
                    };
                }
            }
            return { isPublic: true, ip: cleanIp, version: 4 };
        }
        catch (err) {
            return { isPublic: false, ip: cleanIp, version: 4, reason: `Malformed IPv4: ${err.message}` };
        }
    }
    if (family === 6) {
        try {
            const ipBigInt = ipv6ToBigInt(cleanIp);
            // Check IPv4-mapped IPv6 (::ffff:0:0/96)
            if (matchIpv6Cidr(ipBigInt, '::ffff:0:0', 96)) {
                // Extract lower 32 bits and evaluate as IPv4
                const ipv4Num = Number(ipBigInt & 0xffffffffn) >>> 0;
                const mappedIp = [
                    (ipv4Num >>> 24) & 255,
                    (ipv4Num >>> 16) & 255,
                    (ipv4Num >>> 8) & 255,
                    ipv4Num & 255
                ].join('.');
                for (const range of IPV4_PROHIBITED_RANGES) {
                    if (matchIpv4Cidr(ipv4Num, range.cidr, range.prefix)) {
                        return {
                            isPublic: false,
                            ip: cleanIp,
                            version: 6,
                            reason: `IPv4-mapped IPv6 ${cleanIp} (maps to ${mappedIp}) falls in prohibited IPv4 range ${range.cidr}/${range.prefix} (${range.name})`
                        };
                    }
                }
            }
            for (const range of IPV6_PROHIBITED_RANGES) {
                if (matchIpv6Cidr(ipBigInt, range.cidr, range.prefix)) {
                    return {
                        isPublic: false,
                        ip: cleanIp,
                        version: 6,
                        reason: `IP ${cleanIp} falls in prohibited IPv6 range ${range.cidr}/${range.prefix} (${range.name})`
                    };
                }
            }
            return { isPublic: true, ip: cleanIp, version: 6 };
        }
        catch (err) {
            return { isPublic: false, ip: cleanIp, version: 6, reason: `Malformed IPv6: ${err.message}` };
        }
    }
    return { isPublic: false, ip: cleanIp, version: 4, reason: 'Invalid IP address syntax' };
}
//# sourceMappingURL=ip.js.map