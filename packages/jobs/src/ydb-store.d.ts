import { YdbSearchStore } from './search-store.js';
import { YdbExceptionOutbox } from './exception-outbox.js';
import { Driver } from 'ydb-sdk';
import { Job, JobState, JobFailureCategory, CreateJobParams, AppSettings, UserRecord } from './types.js';
import { JobStore, RateLimitResult } from './store.js';
export interface YdbJobStoreOptions {
    endpoint: string;
    database: string;
    driver?: Driver;
}
export declare class YdbJobStore implements JobStore {
    private driver;
    private isOwnedDriver;
    private settingsCache?;
    private settingsCacheTtlMs;
    private roleUsersCache;
    private roleUsersCacheTtlMs;
    constructor(options: YdbJobStoreOptions);
    searchStore(): YdbSearchStore;
    exceptionOutbox(): YdbExceptionOutbox;
    init(): Promise<void>;
    destroy(): Promise<void>;
    createJobIfNotExist(params: CreateJobParams): Promise<{
        job: Job;
        isDuplicate: boolean;
    }>;
    claimJob(jobId: string, workerId: string, leaseDurationMs: number): Promise<Job | null>;
    updateStatus(jobId: string, status: JobState, options?: {
        expectedVersion?: number;
        finalUrl?: string;
        title?: string;
    }): Promise<Job>;
    saveAttachmentCheckpoint(jobId: string, vkAttachment: string): Promise<Job>;
    failJob(jobId: string, category: JobFailureCategory, safeErrorMessage: string, terminal: boolean): Promise<Job>;
    completeJob(jobId: string): Promise<Job>;
    getJob(jobId: string): Promise<Job | null>;
    checkAndConsumeRateLimit(userId: number, limit: number, windowMs: number): Promise<RateLimitResult>;
    getSettings(): Promise<AppSettings>;
    setSetting(key: string, value: string): Promise<void>;
    deleteSetting(key: string): Promise<void>;
    getUser(userId: number): Promise<UserRecord | null>;
    upsertUserAccess(userId: number, profileLink?: string): Promise<UserRecord>;
    setUserStatus(userId: number, status: number): Promise<void>;
    getUserRoles(userId: number): Promise<number[]>;
    addUserRole(userId: number, role: number): Promise<void>;
    removeUserRole(userId: number, role: number): Promise<void>;
    getUsersByRole(role: number): Promise<number[]>;
}
//# sourceMappingURL=ydb-store.d.ts.map