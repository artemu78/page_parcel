"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultLogger = exports.Logger = void 0;
exports.redactSensitiveData = redactSensitiveData;
exports.sanitizeLogValue = sanitizeLogValue;
const exceptions_js_1 = require("./exceptions.js");
const SECRET_PATTERNS = [
    /(?:github_pat_|gh[pousr]_)[a-zA-Z0-9_]+/g,
    /sk-(?:or-v1-)?[a-zA-Z0-9_-]+/g,
    /access_token=[a-zA-Z0-9._-]+/gi,
    /vk1\.a\.[a-zA-Z0-9._-]+/gi,
    /secret=[a-zA-Z0-9._-]+/gi,
    /bearer\s+[a-zA-Z0-9._-]+/gi,
    /upload_url=[^&\s]+/gi,
    /https?:\/\/[^:]+:[^@]+@/gi
];
function redactSensitiveData(input) {
    let result = input;
    // Exact known credentials cover provider errors echoing plain tokens without a prefix.
    for (const [key, value] of Object.entries(process.env)) {
        if (/TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL/i.test(key) && value && value.length >= 8) {
            result = result.split(value).join('[REDACTED]');
        }
    }
    result = result.replace(/https?:\/\/[^\s"'<>]+/gi, url => url.replace(/[?#].*$/, '?[REDACTED]'));
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, (match) => {
            if (match.toLowerCase().startsWith('access_token='))
                return 'access_token=[REDACTED]';
            if (match.toLowerCase().startsWith('secret='))
                return 'secret=[REDACTED]';
            if (match.toLowerCase().startsWith('bearer '))
                return 'Bearer [REDACTED]';
            if (match.toLowerCase().startsWith('upload_url='))
                return 'upload_url=[REDACTED]';
            if (match.startsWith('vk1.a.'))
                return 'vk1.a.[REDACTED]';
            return '[REDACTED]';
        });
    }
    return result;
}
function sanitizeLogValue(val) {
    if (typeof val === 'string') {
        return redactSensitiveData(val);
    }
    if (Array.isArray(val)) {
        return val.map(sanitizeLogValue);
    }
    if (val !== null && typeof val === 'object') {
        const sanitized = {};
        for (const [k, v] of Object.entries(val)) {
            if (k.toLowerCase().includes('token') || k.toLowerCase().includes('secret') || k.toLowerCase().includes('password')) {
                sanitized[k] = '[REDACTED]';
            }
            else {
                sanitized[k] = sanitizeLogValue(v);
            }
        }
        return sanitized;
    }
    return val;
}
const LOG_LEVEL_PRIORITY = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};
class Logger {
    level;
    defaultContext;
    constructor(level = 'info', defaultContext = {}) {
        this.level = level;
        this.defaultContext = defaultContext;
    }
    child(context) {
        return new Logger(this.level, { ...this.defaultContext, ...context });
    }
    shouldLog(level) {
        return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
    }
    log(level, message, context) {
        if (!this.shouldLog(level))
            return;
        const merged = { ...this.defaultContext, ...context };
        const sanitizedContext = sanitizeLogValue(merged);
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
        }
        else {
            process.stdout.write(out + '\n');
        }
    }
    exception(error, operation, context) {
        const merged = { ...this.defaultContext, ...context };
        const sdkStatus = error !== null && typeof error === 'object'
            ? error.$metadata?.httpStatusCode : undefined;
        if (typeof sdkStatus === 'number') {
            this.info(operation, { ...merged, httpStatus: sdkStatus });
            return;
        }
        if (error instanceof exceptions_js_1.UpstreamResponseError) {
            this.info(operation, { ...merged, service: error.service, httpStatus: error.statusCode });
            return;
        }
        (0, exceptions_js_1.captureException)(error, operation, merged);
        this.error(operation, { ...merged, error: error instanceof Error ? error.message : String(error) });
    }
    debug(message, context) {
        this.log('debug', message, context);
    }
    info(message, context) {
        this.log('info', message, context);
    }
    warn(message, context) {
        this.log('warn', message, context);
    }
    error(message, context) {
        this.log('error', message, context);
    }
}
exports.Logger = Logger;
exports.defaultLogger = new Logger(process.env.LOG_LEVEL || 'info');
//# sourceMappingURL=logger.js.map