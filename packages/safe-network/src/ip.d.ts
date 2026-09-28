export interface IPRangeCheckResult {
    isPublic: boolean;
    ip: string;
    reason?: string;
    version: 4 | 6;
}
export declare function ipv4ToUint32(ip: string): number;
export declare function matchIpv4Cidr(ipNum: number, cidrIp: string, prefixLen: number): boolean;
export declare function ipv6ToBigInt(ip: string): bigint;
export declare function matchIpv6Cidr(ipBigInt: bigint, cidrIp: string, prefixLen: number): boolean;
export declare function classifyIp(ipAddress: string): IPRangeCheckResult;
//# sourceMappingURL=ip.d.ts.map