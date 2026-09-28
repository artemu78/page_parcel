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
exports.validateUrlSyntax = validateUrlSyntax;
const net = __importStar(require("node:net"));
const ip_js_1 = require("./ip.js");
const LOCAL_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'broadcasthost',
    'local',
    'internal',
    'lan'
]);
function validateUrlSyntax(inputUrl) {
    if (typeof inputUrl !== 'string' || inputUrl.trim().length === 0) {
        throw new Error('URL cannot be empty');
    }
    const trimmed = inputUrl.trim();
    // Reject URLs with embedded control characters or spaces
    if (/[\x00-\x1F\x7F\s]/.test(trimmed)) {
        throw new Error('URL contains invalid control characters or whitespace');
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch (err) {
        throw new Error(`Invalid URL format: ${err.message}`);
    }
    // Scheme policy: strictly http: or https:
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Prohibited protocol: ${parsed.protocol}. Only http: and https: are allowed.`);
    }
    // Credential policy: reject username or password
    if (parsed.username || parsed.password) {
        throw new Error('URLs with embedded credentials (username/password) are prohibited');
    }
    // Hostname checks
    let hostname = parsed.hostname.toLowerCase();
    // Strip trailing dot if present for FQDN
    if (hostname.endsWith('.')) {
        hostname = hostname.slice(0, -1);
    }
    if (!hostname || hostname.length === 0) {
        throw new Error('URL hostname is empty');
    }
    // Reject localhost and mDNS/internal local domain patterns
    if (LOCAL_HOSTNAMES.has(hostname) ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.lan') ||
        hostname.endsWith('.home.arpa')) {
        throw new Error(`Prohibited local/internal hostname: ${hostname}`);
    }
    // Port policy: strictly 80 or 443
    let port;
    if (parsed.port) {
        port = Number.parseInt(parsed.port, 10);
        if (Number.isNaN(port) || (port !== 80 && port !== 443)) {
            throw new Error(`Prohibited port: ${parsed.port}. Only ports 80 and 443 are allowed.`);
        }
    }
    else {
        port = parsed.protocol === 'https:' ? 443 : 80;
    }
    // Check if hostname is an IP (handling IPv6 brackets)
    const cleanIpCandidate = hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname;
    const isDirectIp = net.isIP(cleanIpCandidate) !== 0;
    if (isDirectIp) {
        const classification = (0, ip_js_1.classifyIp)(cleanIpCandidate);
        if (!classification.isPublic) {
            throw new Error(`Prohibited direct IP address: ${classification.reason || cleanIpCandidate}`);
        }
    }
    else {
        // If it's a hostname, make sure it doesn't try numeric IP bypasses that failed net.isIP
        // e.g. 0x7f000001 or 2130706433 or octal strings
        if (/^(0x[0-9a-f]+|\d+)$/i.test(hostname)) {
            throw new Error(`Prohibited raw numeric/hex hostname representation: ${hostname}`);
        }
    }
    // Normalized URL
    const normalizedUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
    return {
        originalUrl: inputUrl,
        normalizedUrl,
        protocol: parsed.protocol,
        hostname,
        port,
        pathname: parsed.pathname,
        search: parsed.search,
        isDirectIp,
        directIp: isDirectIp ? cleanIpCandidate : undefined
    };
}
//# sourceMappingURL=url-validator.js.map