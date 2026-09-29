import { Job, JobState, JobFailureCategory, CreateJobParams, AppSettings, UserRecord } from './types.js';
export interface RateLimitResult {
    allowed: boolean;
    retryAfterSeconds?: number;
}
export interface JobStore {
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
    setSetting?(key: string, value: string): Promise<void>;
    deleteSetting?(key: string): Promise<void>;
    getUser?(userId: number): Promise<UserRecord | null>;
    upsertUserAccess?(userId: number, profileLink?: string): Promise<UserRecord>;
    setUserStatus?(userId: number, status: number): Promise<void>;
    getUserRoles?(userId: number): Promise<number[]>;
    getUsersByRole?(role: number): Promise<number[]>;
    addUserRole?(userId: number, role: number): Promise<void>;
    removeUserRole?(userId: number, role: number): Promise<void>;
}
export declare class MemoryJobStore implements JobStore {
    private jobs;
    private eventIndex;
    private userRateLimits;
    private settings;
    private users;
    private roles;
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
//# sourceMappingURL=store.d.ts.map