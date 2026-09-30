"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureExceptionReporting = configureExceptionReporting;
exports.installRuntimeExceptionHandlers = installRuntimeExceptionHandlers;
const logger_js_1 = require("./logger.js");
const exceptions_js_1 = require("./exceptions.js");
/** Configure before bootstrap so startup exceptions are also captured. */
function configureExceptionReporting(service, outbox) {
    const token = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    if (!token || !repository) {
        if (process.env.NODE_ENV === 'production')
            throw new Error('GitHub exception reporting requires GITHUB_TOKEN and GITHUB_REPOSITORY');
        logger_js_1.defaultLogger.warn('GitHub exception reporting disabled: configure GITHUB_TOKEN and GITHUB_REPOSITORY');
        return;
    }
    (0, exceptions_js_1.setExceptionReporter)(new exceptions_js_1.GitHubExceptionReporter({
        token, repository, outbox, service,
        onInfo: status => logger_js_1.defaultLogger.info('GitHub HTTP response', { service, httpStatus: status }),
        onFailure: reportId => logger_js_1.defaultLogger.warn('Exception report pending; delivery will retry', { service, reportId })
    }));
}
function installRuntimeExceptionHandlers(service) {
    let terminating = false;
    const fatal = async (error, operation) => {
        if (terminating)
            return;
        terminating = true;
        logger_js_1.defaultLogger.child({ service }).exception(error, operation);
        // A corrupted process must exit. Reporting gets a bounded grace period.
        const deadline = setTimeout(() => process.exit(1), 15000);
        await (0, exceptions_js_1.flushExceptionReports)();
        clearTimeout(deadline);
        process.exit(1);
    };
    const uncaught = (error) => { void fatal(error, 'Uncaught exception'); };
    const rejection = (error) => { void fatal(error, 'Unhandled rejection'); };
    process.on('uncaughtException', uncaught);
    process.on('unhandledRejection', rejection);
    const retry = setInterval(() => { void (0, exceptions_js_1.flushExceptionReports)(); }, 30000);
    retry.unref();
    return () => {
        clearInterval(retry);
        process.off('uncaughtException', uncaught);
        process.off('unhandledRejection', rejection);
    };
}
//# sourceMappingURL=runtime.js.map