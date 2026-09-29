import { Job, JobState, JobFailureCategory, CreateJobParams, AppSettings, parseSettingsMap, UserRecord, RoleRecord } from './types.js';

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

export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, Job>();
  private eventIndex = new Map<string, string>(); // eventId -> jobId
  private userRateLimits = new Map<number, number[]>(); // userId -> timestamps
  private settings = new Map<string, string>();
  private users = new Map<number, UserRecord>();
  private roles: RoleRecord[] = [];

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

  public async getSettings(): Promise<AppSettings> {
    return parseSettingsMap(this.settings);
  }

  public async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  public async deleteSetting(key: string): Promise<void> {
    this.settings.delete(key);
  }

  public async getUser(userId: number): Promise<UserRecord | null> {
    const user = this.users.get(userId);
    return user ? { ...user } : null;
  }

  public async upsertUserAccess(userId: number, profileLink?: string): Promise<UserRecord> {
    const now = Date.now();
    const existing = this.users.get(userId);
    const link = profileLink || `https://vk.com/id${userId}`;

    if (existing) {
      existing.lastAccess = now;
      existing.requestsCount += 1;
      existing.profileLink = link;
      return { ...existing };
    }

    const newUser: UserRecord = {
      id: userId,
      createdAt: now,
      lastAccess: now,
      requestsCount: 1,
      status: 0,
      profileLink: link
    };
    this.users.set(userId, newUser);
    return { ...newUser };
  }

  public async setUserStatus(userId: number, status: number): Promise<void> {
    const user = this.users.get(userId);
    if (user) {
      user.status = status;
    } else {
      this.users.set(userId, {
        id: userId,
        createdAt: Date.now(),
        lastAccess: Date.now(),
        requestsCount: 0,
        status,
        profileLink: `https://vk.com/id${userId}`
      });
    }
  }

  public async getUserRoles(userId: number): Promise<number[]> {
    return this.roles.filter(r => r.user === userId).map(r => r.role);
  }

  public async addUserRole(userId: number, role: number): Promise<void> {
    if (!this.roles.some(r => r.user === userId && r.role === role)) {
      this.roles.push({ user: userId, role });
    }
  }

  public async removeUserRole(userId: number, role: number): Promise<void> {
    this.roles = this.roles.filter(r => !(r.user === userId && r.role === role));
  }

  public async getUsersByRole(role: number): Promise<number[]> {
    return Array.from(new Set(this.roles.filter(r => r.role === role).map(r => r.user)));
  }
}
