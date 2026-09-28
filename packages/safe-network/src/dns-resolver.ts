import * as dns from 'node:dns/promises';
import { classifyIp } from './ip.js';

export interface ResolvedSafeHost {
  hostname: string;
  publicIps: string[];
  selectedIp: string;
}

export interface DnsResolverOptions {
  timeoutMs?: number;
  customDnsResolver?: (hostname: string) => Promise<string[]>;
}

export class SafeDnsResolver {
  private timeoutMs: number;
  private customResolver?: (hostname: string) => Promise<string[]>;

  constructor(options: DnsResolverOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.customResolver = options.customDnsResolver;
  }

  public async resolve(hostname: string): Promise<ResolvedSafeHost> {
    const cleanHost = hostname.toLowerCase();

    let ips: string[] = [];

    if (this.customResolver) {
      ips = await this.customResolver(cleanHost);
    } else {
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
      } finally {
        clearTimeout(timer);
      }
    }

    if (ips.length === 0) {
      throw new Error(`DNS resolution failed for ${hostname}: no A or AAAA records found`);
    }

    // Every single resolved IP MUST be classified as safe and public.
    // If an attacker configures DNS to return a public IP AND 127.0.0.1, we fail closed!
    for (const ip of ips) {
      const classification = classifyIp(ip);
      if (!classification.isPublic) {
        throw new Error(
          `DNS response for ${hostname} contained prohibited IP: ${classification.reason || ip}`
        );
      }
    }

    return {
      hostname: cleanHost,
      publicIps: ips,
      selectedIp: ips[0]
    };
  }
}

export const defaultDnsResolver = new SafeDnsResolver();
