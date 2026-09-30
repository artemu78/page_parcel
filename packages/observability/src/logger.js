"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultLogger = exports.Logger = exports.sanitizeLogValue = exports.redactSensitiveData = void 0;
const redaction_js_1 = require("./redaction.js");
var redaction_js_2 = require("./redaction.js");
Object.defineProperty(exports, "redactSensitiveData", { enumerable: true, get: function () { return redaction_js_2.redactSensitiveData; } });
Object.defineProperty(exports, "sanitizeLogValue", { enumerable: true, get: function () { return redaction_js_2.sanitizeLogValue; } });
const exceptions_js_1 = require("./exceptions.js");
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
        const sanitizedContext = (0, redaction_js_1.sanitizeLogValue)(merged);
        const sanitizedMessage = (0, redaction_js_1.redactSensitiveData)(message);
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