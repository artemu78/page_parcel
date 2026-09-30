import { type ExceptionOutbox } from './exceptions.js';
/** Configure before bootstrap so startup exceptions are also captured. */
export declare function configureExceptionReporting(service: string, outbox?: ExceptionOutbox): void;
export declare function installRuntimeExceptionHandlers(service: string): () => void;
//# sourceMappingURL=runtime.d.ts.map