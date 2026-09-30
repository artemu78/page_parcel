/** A received upstream response is operational information, not a code exception. */
export declare class UpstreamResponseError extends Error {
    readonly service: string;
    readonly statusCode: number;
    constructor(message: string, service: string, statusCode: number);
}
export interface ExceptionReport {
    id: string;
    title: string;
    body: string;
}
export interface ExceptionOutbox {
    save(report: ExceptionReport): Promise<void>;
    pending(): Promise<ExceptionReport[]>;
    remove(id: string): Promise<void>;
}
export interface ExceptionReporter {
    capture(error: unknown, operation: string, context: Record<string, unknown>): void;
    flush(): Promise<void>;
}
export interface GitHubExceptionReporterOptions {
    token: string;
    repository: string;
    service?: string;
    fetch?: typeof fetch;
    outbox?: ExceptionOutbox;
    onInfo?: (status: number) => void;
    onFailure?: (reportId: string) => void;
}
export declare function buildExceptionReport(error: unknown, operation: string, context: Record<string, unknown>): ExceptionReport;
export declare class GitHubExceptionReporter implements ExceptionReporter {
    private options;
    private reports;
    private seen;
    private requested;
    private flushing?;
    private request;
    private endpoint;
    constructor(options: GitHubExceptionReporterOptions);
    capture(error: unknown, operation: string, context: Record<string, unknown>): void;
    flush(): Promise<void>;
    private drain;
    private headers;
}
export declare function setExceptionReporter(value: ExceptionReporter | undefined): void;
export declare function captureException(error: unknown, operation: string, context?: Record<string, unknown>): void;
export declare function flushExceptionReports(): Promise<void>;
//# sourceMappingURL=exceptions.d.ts.map