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

const SECRET_PATTERNS = [
  /access_token=[a-zA-Z0-9._-]+/gi,
  /vk1\.a\.[a-zA-Z0-9._-]+/gi,
  /secret=[a-zA-Z0-9._-]+/gi,
  /bearer\s+[a-zA-Z0-9._-]+/gi,
  /upload_url=[^&\s]+/gi,
  /https?:\/\/[^:]+:[^@]+@/gi
];

export function redactSensitiveData(input: string): string {
  let result = input;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.toLowerCase().startsWith('access_token=')) return 'access_token=[REDACTED]';
      if (match.toLowerCase().startsWith('secret=')) return 'secret=[REDACTED]';
      if (match.toLowerCase().startsWith('bearer ')) return 'Bearer [REDACTED]';
      if (match.toLowerCase().startsWith('upload_url=')) return 'upload_url=[REDACTED]';
      if (match.startsWith('vk1.a.')) return 'vk1.a.[REDACTED]';
      return '[REDACTED]';
    });
  }
  return result;
}

export function sanitizeLogValue(val: unknown): unknown {
  if (typeof val === 'string') {
    return redactSensitiveData(val);
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeLogValue);
  }
  if (val !== null && typeof val === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (k.toLowerCase().includes('token') || k.toLowerCase().includes('secret') || k.toLowerCase().includes('password')) {
        sanitized[k] = '[REDACTED]';
      } else {
        sanitized[k] = sanitizeLogValue(v);
      }
    }
    return sanitized;
  }
  return val;
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
