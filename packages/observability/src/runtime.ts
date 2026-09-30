import { defaultLogger } from './logger.js';
import { GitHubExceptionReporter, setExceptionReporter, flushExceptionReports, type ExceptionOutbox } from './exceptions.js';

/** Configure before bootstrap so startup exceptions are also captured. */
export function configureExceptionReporting(service: string, outbox?: ExceptionOutbox): void {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) {
    if (process.env.NODE_ENV === 'production') throw new Error('GitHub exception reporting requires GITHUB_TOKEN and GITHUB_REPOSITORY');
    defaultLogger.warn('GitHub exception reporting disabled: configure GITHUB_TOKEN and GITHUB_REPOSITORY');
    return;
  }
  setExceptionReporter(new GitHubExceptionReporter({
    token, repository, outbox, service,
    onInfo: status => defaultLogger.info('GitHub HTTP response', { service, httpStatus: status }),
    onFailure: reportId => defaultLogger.warn('Exception report pending; delivery will retry', { service, reportId })
  }));
}

export function installRuntimeExceptionHandlers(service: string): () => void {
  let terminating = false;
  const fatal = async (error: unknown, operation: string) => {
    if (terminating) return;
    terminating = true;
    defaultLogger.child({ service }).exception(error, operation);
    // A corrupted process must exit. Reporting gets a bounded grace period.
    const deadline = setTimeout(() => process.exit(1), 15000);
    await flushExceptionReports();
    clearTimeout(deadline);
    process.exit(1);
  };
  const uncaught = (error: Error) => { void fatal(error, 'Uncaught exception'); };
  const rejection = (error: unknown) => { void fatal(error, 'Unhandled rejection'); };
  process.on('uncaughtException', uncaught);
  process.on('unhandledRejection', rejection);
  const retry = setInterval(() => { void flushExceptionReports(); }, 30000);
  retry.unref();
  return () => {
    clearInterval(retry);
    process.off('uncaughtException', uncaught);
    process.off('unhandledRejection', rejection);
  };
}
