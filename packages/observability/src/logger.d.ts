export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogContext {
    jobId?: string;
    requestId?: string;
    category?: string;
    status?: string;
    attempts?: number;
    durationMs?: number;
    [key: string]: unknown;
}
export declare function redactSensitiveData(input: string): string;
export declare function sanitizeLogValue(val: unknown): unknown;
export declare class Logger {
    private level;
    private defaultContext;
    constructor(level?: LogLevel, defaultContext?: LogContext);
    child(context: LogContext): Logger;
    private shouldLog;
    private log;
    debug(message: string, context?: LogContext): void;
    info(message: string, context?: LogContext): void;
    warn(message: string, context?: LogContext): void;
    error(message: string, context?: LogContext): void;
}
export declare const defaultLogger: Logger;
//# sourceMappingURL=logger.d.ts.map