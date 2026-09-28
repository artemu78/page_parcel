"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryJobStore = void 0;
class MemoryJobStore {
    jobs = new Map();
    eventIndex = new Map(); // eventId -> jobId
    userRateLimits = new Map(); // userId -> timestamps
    async createJobIfNotExist(params) {
        const existingJobId = this.eventIndex.get(params.eventId);
        if (existingJobId) {
            const existing = this.jobs.get(existingJobId);
            if (existing) {
                return { job: { ...existing }, isDuplicate: true };
            }
        }
        const now = Date.now();
        const ttlMs = (params.ttlSeconds ?? 86400) * 1000;
        const jobId = params.id ?? `job_${now}_${Math.random().toString(36).slice(2, 9)}`;
        const newJob = {
            id: jobId,
            ownerId: params.ownerId,
            peerId: params.peerId,
            eventId: params.eventId,
            submittedUrl: params.submittedUrl,
            status: 'accepted',
            version: 1,
            attempts: 0,
            maxAttempts: params.maxAttempts ?? 3,
            createdAt: now,
            updatedAt: now,
            expiresAt: now + ttlMs
        };
        this.jobs.set(jobId, newJob);
        this.eventIndex.set(params.eventId, jobId);
        return { job: { ...newJob }, isDuplicate: false };
    }
    async claimJob(jobId, workerId, leaseDurationMs) {
        const job = this.jobs.get(jobId);
        if (!job)
            return null;
        const now = Date.now();
        // Do not claim expired jobs
        if (now >= job.expiresAt) {
            return null;
        }
        // Do not claim completed or permanently failed jobs
        if (job.status === 'completed' || job.status === 'failed') {
            return null;
        }
        // Check lease
        const isLeaseActive = job.leaseExpiresAt && job.leaseExpiresAt > now;
        const isAvailableForClaim = job.status === 'accepted' ||
            job.status === 'queued' ||
            !isLeaseActive;
        if (!isAvailableForClaim) {
            return null;
        }
        // Atomic update
        job.status = 'rendering';
        job.attempts += 1;
        job.leaseOwner = workerId;
        job.leaseExpiresAt = now + leaseDurationMs;
        job.version += 1;
        job.updatedAt = now;
        return { ...job };
    }
    async updateStatus(jobId, status, options) {
        const job = this.jobs.get(jobId);
        if (!job)
            throw new Error(`Job not found: ${jobId}`);
        if (options?.expectedVersion !== undefined && job.version !== options.expectedVersion) {
            throw new Error(`Optimistic lock failed for job ${jobId}: expected version ${options.expectedVersion}, got ${job.version}`);
        }
        const now = Date.now();
        job.status = status;
        job.version += 1;
        job.updatedAt = now;
        if (options?.finalUrl)
            job.finalUrl = options.finalUrl;
        if (options?.title)
            job.title = options.title;
        return { ...job };
    }
    async saveAttachmentCheckpoint(jobId, vkAttachment) {
        const job = this.jobs.get(jobId);
        if (!job)
            throw new Error(`Job not found: ${jobId}`);
        const now = Date.now();
        job.vkAttachment = vkAttachment;
        job.status = 'delivering';
        job.version += 1;
        job.updatedAt = now;
        return { ...job };
    }
    async failJob(jobId, category, safeErrorMessage, terminal) {
        const job = this.jobs.get(jobId);
        if (!job)
            throw new Error(`Job not found: ${jobId}`);
        const now = Date.now();
        job.status = terminal ? 'failed' : 'queued';
        job.failureCategory = category;
        job.safeErrorMessage = safeErrorMessage;
        job.version += 1;
        job.updatedAt = now;
        job.leaseOwner = undefined;
        job.leaseExpiresAt = undefined;
        return { ...job };
    }
    async completeJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job)
            throw new Error(`Job not found: ${jobId}`);
        const now = Date.now();
        job.status = 'completed';
        job.version += 1;
        job.updatedAt = now;
        job.leaseOwner = undefined;
        job.leaseExpiresAt = undefined;
        return { ...job };
    }
    async getJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job)
            return null;
        // Check expiration
        if (Date.now() >= job.expiresAt) {
            return null;
        }
        return { ...job };
    }
    async checkAndConsumeRateLimit(userId, limit, windowMs) {
        const now = Date.now();
        const timestamps = this.userRateLimits.get(userId) || [];
        const validTimestamps = timestamps.filter(t => now - t < windowMs);
        if (validTimestamps.length >= limit) {
            const oldestInWindow = validTimestamps[0];
            const retryAfterSeconds = Math.ceil((oldestInWindow + windowMs - now) / 1000);
            return { allowed: false, retryAfterSeconds };
        }
        validTimestamps.push(now);
        this.userRateLimits.set(userId, validTimestamps);
        return { allowed: true };
    }
}
exports.MemoryJobStore = MemoryJobStore;
//# sourceMappingURL=store.js.map