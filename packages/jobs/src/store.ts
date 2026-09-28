import { Job, JobState, JobFailureCategory, CreateJobParams } from './types.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface JobStore {
  createJobIfNotExist(params: CreateJobParams): Promise<{ job: Job; isDuplicate: boolean }>;
  claimJob(jobId: string, workerId: string, leaseDurationMs: number): Promise<Job | null>;
  updateStatus(
    jobId: string,
    status: JobState,
    options?: { expectedVersion?: number; finalUrl?: string; title?: string }
  ): Promise<Job>;
  saveAttachmentCheckpoint(jobId: string, vkAttachment: string): Promise<Job>;
  failJob(
    jobId: string,
    category: JobFailureCategory,
    safeErrorMessage: string,
    terminal: boolean
  ): Promise<Job>;
  completeJob(jobId: string): Promise<Job>;
  getJob(jobId: string): Promise<Job | null>;
  checkAndConsumeRateLimit(
    userId: number,
    limit: number,
    windowMs: number
  ): Promise<RateLimitResult>;
}

export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, Job>();
  private eventIndex = new Map<string, string>(); // eventId -> jobId
  private userRateLimits = new Map<number, number[]>(); // userId -> timestamps

  public async createJobIfNotExist(params: CreateJobParams): Promise<{ job: Job; isDuplicate: boolean }> {
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

    const newJob: Job = {
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

  public async claimJob(jobId: string, workerId: string, leaseDurationMs: number): Promise<Job | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;

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
    const isAvailableForClaim =
      job.status === 'accepted' ||
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

  public async updateStatus(
    jobId: string,
    status: JobState,
    options?: { expectedVersion?: number; finalUrl?: string; title?: string }
  ): Promise<Job> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    if (options?.expectedVersion !== undefined && job.version !== options.expectedVersion) {
      throw new Error(`Optimistic lock failed for job ${jobId}: expected version ${options.expectedVersion}, got ${job.version}`);
    }

    const now = Date.now();
    job.status = status;
    job.version += 1;
    job.updatedAt = now;
    if (options?.finalUrl) job.finalUrl = options.finalUrl;
    if (options?.title) job.title = options.title;

    return { ...job };
  }

  public async saveAttachmentCheckpoint(jobId: string, vkAttachment: string): Promise<Job> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const now = Date.now();
    job.vkAttachment = vkAttachment;
    job.status = 'delivering';
    job.version += 1;
    job.updatedAt = now;

    return { ...job };
  }

  public async failJob(
    jobId: string,
    category: JobFailureCategory,
    safeErrorMessage: string,
    terminal: boolean
  ): Promise<Job> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

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

  public async completeJob(jobId: string): Promise<Job> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const now = Date.now();
    job.status = 'completed';
    job.version += 1;
    job.updatedAt = now;
    job.leaseOwner = undefined;
    job.leaseExpiresAt = undefined;

    return { ...job };
  }

  public async getJob(jobId: string): Promise<Job | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    // Check expiration
    if (Date.now() >= job.expiresAt) {
      return null;
    }

    return { ...job };
  }

  public async checkAndConsumeRateLimit(
    userId: number,
    limit: number,
    windowMs: number
  ): Promise<RateLimitResult> {
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
