export interface ResolvedSafeHost {
    hostname: string;
    publicIps: string[];
    selectedIp: string;
}
export interface DnsResolverOptions {
    timeoutMs?: number;
    customDnsResolver?: (hostname: string) => Promise<string[]>;
}
export declare class SafeDnsResolver {
    private timeoutMs;
    private customResolver?;
    constructor(options?: DnsResolverOptions);
    resolve(hostname: string): Promise<ResolvedSafeHost>;
}
export declare const defaultDnsResolver: SafeDnsResolver;
//# sourceMappingURL=dns-resolver.d.ts.map