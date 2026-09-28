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
exports.defaultDnsResolver = exports.SafeDnsResolver = void 0;
const dns = __importStar(require("node:dns/promises"));
const ip_js_1 = require("./ip.js");
class SafeDnsResolver {
    timeoutMs;
    customResolver;
    constructor(options = {}) {
        this.timeoutMs = options.timeoutMs ?? 3000;
        this.customResolver = options.customDnsResolver;
    }
    async resolve(hostname) {
        const cleanHost = hostname.toLowerCase();
        let ips = [];
        if (this.customResolver) {
            ips = await this.customResolver(cleanHost);
        }
        else {
            // Resolve A and AAAA in parallel with bounded timeout
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);
            try {
                const [v4Results, v6Results] = await Promise.allSettled([
                    dns.resolve4(cleanHost),
                    dns.resolve6(cleanHost)
                ]);
                if (v4Results.status === 'fulfilled') {
                    ips.push(...v4Results.value);
                }
                if (v6Results.status === 'fulfilled') {
                    ips.push(...v6Results.value);
                }
            }
            finally {
                clearTimeout(timer);
            }
        }
        if (ips.length === 0) {
            throw new Error(`DNS resolution failed for ${hostname}: no A or AAAA records found`);
        }
        // Every single resolved IP MUST be classified as safe and public.
        // If an attacker configures DNS to return a public IP AND 127.0.0.1, we fail closed!
        for (const ip of ips) {
            const classification = (0, ip_js_1.classifyIp)(ip);
            if (!classification.isPublic) {
                throw new Error(`DNS response for ${hostname} contained prohibited IP: ${classification.reason || ip}`);
            }
        }
        return {
            hostname: cleanHost,
            publicIps: ips,
            selectedIp: ips[0]
        };
    }
}
exports.SafeDnsResolver = SafeDnsResolver;
exports.defaultDnsResolver = new SafeDnsResolver();
//# sourceMappingURL=dns-resolver.js.map