import { Driver } from 'ydb-sdk';
import type { ExceptionOutbox, ExceptionReport } from '@readable-web/observability';
/** Separate from job attempts and delivery checkpoints; one row per code exception. */
export declare class YdbExceptionOutbox implements ExceptionOutbox {
    private driver;
    private owner;
    constructor(driver: Driver);
    init(): Promise<void>;
    save(report: ExceptionReport): Promise<void>;
    pending(): Promise<ExceptionReport[]>;
    remove(id: string): Promise<void>;
}
//# sourceMappingURL=exception-outbox.d.ts.map