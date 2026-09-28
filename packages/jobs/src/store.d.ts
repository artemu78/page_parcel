import { Job, JobState, JobFailureCategory, CreateJobParams } from './types.js';
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
}
export declare class MemoryJobStore implements JobStore {
    private jobs;
    private eventIndex;
    private userRateLimits;
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
}
//# sourceMappingURL=store.d.ts.map