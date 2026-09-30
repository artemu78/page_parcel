import { redactSensitiveData, sanitizeLogValue } from './redaction.js';
export { redactSensitiveData, sanitizeLogValue } from './redaction.js';
import { captureException, UpstreamResponseError } from './exceptions.js';
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

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

export class Logger {
  private level: LogLevel;
  private defaultContext: LogContext;

  constructor(level: LogLevel = 'info', defaultContext: LogContext = {}) {
    this.level = level;
    this.defaultContext = defaultContext;
  }

  public child(context: LogContext): Logger {
    return new Logger(this.level, { ...this.defaultContext, ...context });
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.shouldLog(level)) return;

    const merged = { ...this.defaultContext, ...context };
    const sanitizedContext = sanitizeLogValue(merged) as LogContext;
    const sanitizedMessage = redactSensitiveData(message);

    const record = {
      timestamp: new Date().toISOString(),
      level,
      message: sanitizedMessage,
      ...sanitizedContext
    };

    const out = JSON.stringify(record);
    if (level === 'error') {
      process.stderr.write(out + '\n');
    } else {
      process.stdout.write(out + '\n');
    }
  }

  public exception(error: unknown, operation: string, context?: LogContext): void {
    const merged = { ...this.defaultContext, ...context };
    const sdkStatus = error !== null && typeof error === 'object'
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode : undefined;
    if (typeof sdkStatus === 'number') {
      this.info(operation, { ...merged, httpStatus: sdkStatus });
      return;
    }
    if (error instanceof UpstreamResponseError) {
      this.info(operation, { ...merged, service: error.service, httpStatus: error.statusCode });
      return;
    }
    captureException(error, operation, merged);
    this.error(operation, { ...merged, error: error instanceof Error ? error.message : String(error) });
  }

  public debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  public info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  public warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  public error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }
}

export const defaultLogger = new Logger((process.env.LOG_LEVEL as LogLevel) || 'info');
