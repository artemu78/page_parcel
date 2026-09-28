export interface ValidatedUrl {
    originalUrl: string;
    normalizedUrl: string;
    protocol: 'http:' | 'https:';
    hostname: string;
    port: number;
    pathname: string;
    search: string;
    isDirectIp: boolean;
    directIp?: string;
}
export declare function validateUrlSyntax(inputUrl: string): ValidatedUrl;
//# sourceMappingURL=url-validator.d.ts.map