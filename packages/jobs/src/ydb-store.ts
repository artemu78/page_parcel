import { Driver, getCredentialsFromEnv, TypedValues, TypedData, AUTO_TX } from 'ydb-sdk';
import { Job, JobState, JobFailureCategory, CreateJobParams, AppSettings, parseSettingsMap, UserRecord, RoleRecord } from './types.js';
import { JobStore, RateLimitResult } from './store.js';

export interface YdbJobStoreOptions {
  endpoint: string;
  database: string;
  driver?: Driver;
}

export class YdbJobStore implements JobStore {
  private driver: Driver;
  private isOwnedDriver: boolean;
  private settingsCache?: { data: AppSettings; expiresAt: number };
  private settingsCacheTtlMs = 15000; // 15 seconds
  private roleUsersCache = new Map<number, { users: number[]; expiresAt: number }>();
  private roleUsersCacheTtlMs = 15000; // 15 seconds

  constructor(options: YdbJobStoreOptions) {
    if (options.driver) {
      this.driver = options.driver;
      this.isOwnedDriver = false;
    } else {
      let endpoint = options.endpoint;
      if (!endpoint.startsWith('grpcs://') && !endpoint.startsWith('grpc://')) {
        endpoint = `grpcs://${endpoint}`;
      }
      this.driver = new Driver({
        endpoint,
        database: options.database,
        authService: getCredentialsFromEnv()
      });
      this.isOwnedDriver = true;
    }
  }

  public async init(): Promise<void> {
    // Non-blocking warmup
    this.driver.ready(5000).catch(() => {});

    // Best-effort auto-creation of Settings, Users, and Roles tables
    this.driver.tableClient.withSession(async (session) => {
      await session.executeQuery(`
        CREATE TABLE IF NOT EXISTS \`Settings\` (
          key Utf8,
          value Utf8,
          PRIMARY KEY (key)
        );
      `);

      await session.executeQuery(`
        CREATE TABLE IF NOT EXISTS \`Users\` (
          ID Int64,
          CreatedAt Timestamp,
          LastAccess Timestamp,
          RequestsCount Int64,
          Status Int32,
          ProfileLink Utf8,
          PRIMARY KEY (ID)
        );
      `);

      await session.executeQuery(`
        CREATE TABLE IF NOT EXISTS \`Roles\` (
          User Int64,
          Role Int32,
          PRIMARY KEY (User, Role)
        );
      `);

      // Delete deprecated ErrorListeners and Admin records from Settings table
      await session.executeQuery(`
        DELETE FROM \`Settings\` WHERE key = 'ErrorListeners' OR key = 'AdminID' OR key = 'Admin';
      `);
    }).catch(() => {
      // In case table creation is restricted or already exists
    });
  }

  public async destroy(): Promise<void> {
    if (this.isOwnedDriver) {
      await this.driver.destroy();
    }
  }

  public async createJobIfNotExist(params: CreateJobParams): Promise<{ job: Job; isDuplicate: boolean }> {
    return await this.driver.tableClient.withSession(async (session) => {
      // 1. Check idempotency by eventId
      const selectEventQuery = `
        DECLARE $event_id AS Utf8;
        SELECT job_id FROM events WHERE event_id = $event_id;
      `;
      const eventRes = await session.executeQuery(selectEventQuery, {
        '$event_id': TypedValues.utf8(params.eventId)
      }, AUTO_TX);

      const eventRows = TypedData.createNativeObjects(eventRes.resultSets[0]) as unknown as Array<{ job_id: string }>;
      if (eventRows.length > 0 && eventRows[0].job_id) {
        const existingJobId = eventRows[0].job_id;
        const existingJob = await this.getJob(existingJobId);
        if (existingJob) {
          return { job: existingJob, isDuplicate: true };
        }
      }

      // 2. Create new job
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

      const insertJobQuery = `
        DECLARE $id AS Utf8;
        DECLARE $owner_id AS Int64;
        DECLARE $peer_id AS Int64;
        DECLARE $event_id AS Utf8;
        DECLARE $submitted_url AS Utf8;
        DECLARE $status AS Utf8;
        DECLARE $version AS Int64;
        DECLARE $attempts AS Int64;
        DECLARE $max_attempts AS Int64;
        DECLARE $created_at AS Int64;
        DECLARE $updated_at AS Int64;
        DECLARE $expires_at AS Int64;

        UPSERT INTO jobs (
          id, owner_id, peer_id, event_id, submitted_url,
          status, version, attempts, max_attempts,
          created_at, updated_at, expires_at
        ) VALUES (
          $id, $owner_id, $peer_id, $event_id, $submitted_url,
          $status, $version, $attempts, $max_attempts,
          $created_at, $updated_at, $expires_at
        );

        UPSERT INTO events (event_id, job_id, created_at)
        VALUES ($event_id, $id, $created_at);
      `;

      await session.executeQuery(insertJobQuery, {
        '$id': TypedValues.utf8(newJob.id),
        '$owner_id': TypedValues.int64(newJob.ownerId),
        '$peer_id': TypedValues.int64(newJob.peerId),
        '$event_id': TypedValues.utf8(newJob.eventId),
        '$submitted_url': TypedValues.utf8(newJob.submittedUrl),
        '$status': TypedValues.utf8(newJob.status),
        '$version': TypedValues.int64(newJob.version),
        '$attempts': TypedValues.int64(newJob.attempts),
        '$max_attempts': TypedValues.int64(newJob.maxAttempts),
        '$created_at': TypedValues.int64(newJob.createdAt),
        '$updated_at': TypedValues.int64(newJob.updatedAt),
        '$expires_at': TypedValues.int64(newJob.expiresAt)
      }, AUTO_TX);

      return { job: newJob, isDuplicate: false };
    });
  }

  public async claimJob(jobId: string, workerId: string, leaseDurationMs: number): Promise<Job | null> {
    return await this.driver.tableClient.withSession(async (session) => {
      const job = await this.getJob(jobId);
      if (!job) return null;

      if (job.status === 'completed' || job.status === 'failed') {
        return null;
      }

      const now = Date.now();
      if (job.leaseExpiresAt && job.leaseExpiresAt > now && job.leaseOwner !== workerId) {
        return null;
      }

      const newVersion = job.version + 1;
      const newAttempts = job.attempts + 1;
      const leaseExpiresAt = now + leaseDurationMs;

      const updateQuery = `
        DECLARE $id AS Utf8;
        DECLARE $expected_version AS Int64;
        DECLARE $new_version AS Int64;
        DECLARE $worker_id AS Utf8;
        DECLARE $lease_expires_at AS Int64;
        DECLARE $new_attempts AS Int64;
        DECLARE $now AS Int64;

        UPDATE jobs
        SET
          lease_owner = $worker_id,
          lease_expires_at = $lease_expires_at,
          status = 'rendering',
          attempts = $new_attempts,
          version = $new_version,
          updated_at = $now
        WHERE id = $id AND version = $expected_version;
      `;

      await session.executeQuery(updateQuery, {
        '$id': TypedValues.utf8(jobId),
        '$expected_version': TypedValues.int64(job.version),
        '$new_version': TypedValues.int64(newVersion),
        '$worker_id': TypedValues.utf8(workerId),
        '$lease_expires_at': TypedValues.int64(leaseExpiresAt),
        '$new_attempts': TypedValues.int64(newAttempts),
        '$now': TypedValues.int64(now)
      }, AUTO_TX);

      return {
        ...job,
        leaseOwner: workerId,
        leaseExpiresAt,
        status: 'rendering',
        attempts: newAttempts,
        version: newVersion,
        updatedAt: now
      };
    });
  }

  public async updateStatus(
    jobId: string,
    status: JobState,
    options?: { expectedVersion?: number; finalUrl?: string; title?: string }
  ): Promise<Job> {
    return await this.driver.tableClient.withSession(async (session) => {
      const job = await this.getJob(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);

      if (options?.expectedVersion !== undefined && job.version !== options.expectedVersion) {
        throw new Error(`Version conflict updating job ${jobId}: expected ${options.expectedVersion}, got ${job.version}`);
      }

      const now = Date.now();
      const newVersion = job.version + 1;
      const finalUrl = options?.finalUrl ?? job.finalUrl;
      const title = options?.title ?? job.title;

      const updateQuery = `
        DECLARE $id AS Utf8;
        DECLARE $status AS Utf8;
        DECLARE $version AS Int64;
        DECLARE $updated_at AS Int64;
        DECLARE $final_url AS Utf8;
        DECLARE $title AS Utf8;

        UPDATE jobs
        SET
          status = $status,
          version = $version,
          updated_at = $updated_at,
          final_url = $final_url,
          title = $title
        WHERE id = $id;
      `;

      await session.executeQuery(updateQuery, {
        '$id': TypedValues.utf8(jobId),
        '$status': TypedValues.utf8(status),
        '$version': TypedValues.int64(newVersion),
        '$updated_at': TypedValues.int64(now),
        '$final_url': TypedValues.utf8(finalUrl ?? ''),
        '$title': TypedValues.utf8(title ?? '')
      }, AUTO_TX);

      return {
        ...job,
        status,
        finalUrl,
        title,
        version: newVersion,
        updatedAt: now
      };
    });
  }

  public async saveAttachmentCheckpoint(jobId: string, vkAttachment: string): Promise<Job> {
    return await this.driver.tableClient.withSession(async (session) => {
      const job = await this.getJob(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);

      const now = Date.now();
      const newVersion = job.version + 1;

      const updateQuery = `
        DECLARE $id AS Utf8;
        DECLARE $vk_attachment AS Utf8;
        DECLARE $version AS Int64;
        DECLARE $updated_at AS Int64;

        UPDATE jobs
        SET
          vk_attachment = $vk_attachment,
          version = $version,
          updated_at = $updated_at
        WHERE id = $id;
      `;

      await session.executeQuery(updateQuery, {
        '$id': TypedValues.utf8(jobId),
        '$vk_attachment': TypedValues.utf8(vkAttachment),
        '$version': TypedValues.int64(newVersion),
        '$updated_at': TypedValues.int64(now)
      }, AUTO_TX);

      return {
        ...job,
        vkAttachment,
        version: newVersion,
        updatedAt: now
      };
    });
  }

  public async failJob(
    jobId: string,
    category: JobFailureCategory,
    safeErrorMessage: string,
    terminal: boolean
  ): Promise<Job> {
    return await this.driver.tableClient.withSession(async (session) => {
      const job = await this.getJob(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);

      const now = Date.now();
      const newVersion = job.version + 1;
      const status: JobState = terminal ? 'failed' : 'queued';

      const updateQuery = `
        DECLARE $id AS Utf8;
        DECLARE $status AS Utf8;
        DECLARE $category AS Utf8;
        DECLARE $message AS Utf8;
        DECLARE $version AS Int64;
        DECLARE $updated_at AS Int64;

        UPDATE jobs
        SET
          status = $status,
          failure_category = $category,
          safe_error_message = $message,
          lease_owner = NULL,
          lease_expires_at = 0,
          version = $version,
          updated_at = $updated_at
        WHERE id = $id;
      `;

      await session.executeQuery(updateQuery, {
        '$id': TypedValues.utf8(jobId),
        '$status': TypedValues.utf8(status),
        '$category': TypedValues.utf8(category),
        '$message': TypedValues.utf8(safeErrorMessage),
        '$version': TypedValues.int64(newVersion),
        '$updated_at': TypedValues.int64(now)
      }, AUTO_TX);

      return {
        ...job,
        status,
        failureCategory: category,
        safeErrorMessage,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        version: newVersion,
        updatedAt: now
      };
    });
  }

  public async completeJob(jobId: string): Promise<Job> {
    return await this.driver.tableClient.withSession(async (session) => {
      const job = await this.getJob(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);

      const now = Date.now();
      const newVersion = job.version + 1;

      const updateQuery = `
        DECLARE $id AS Utf8;
        DECLARE $version AS Int64;
        DECLARE $updated_at AS Int64;

        UPDATE jobs
        SET
          status = 'completed',
          lease_owner = NULL,
          lease_expires_at = 0,
          version = $version,
          updated_at = $updated_at
        WHERE id = $id;
      `;

      await session.executeQuery(updateQuery, {
        '$id': TypedValues.utf8(jobId),
        '$version': TypedValues.int64(newVersion),
        '$updated_at': TypedValues.int64(now)
      }, AUTO_TX);

      return {
        ...job,
        status: 'completed',
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        version: newVersion,
        updatedAt: now
      };
    });
  }

  public async getJob(jobId: string): Promise<Job | null> {
    return await this.driver.tableClient.withSession(async (session) => {
      const selectQuery = `
        DECLARE $id AS Utf8;
        SELECT * FROM jobs WHERE id = $id;
      `;

      const res = await session.executeQuery(selectQuery, {
        '$id': TypedValues.utf8(jobId)
      }, AUTO_TX);

      const rows = TypedData.createNativeObjects(res.resultSets[0]) as Array<Record<string, any>>;
      if (rows.length === 0) return null;

      const row = rows[0];
      return {
        id: row.id,
        ownerId: Number(row.owner_id),
        peerId: Number(row.peer_id),
        eventId: row.event_id,
        submittedUrl: row.submitted_url,
        finalUrl: row.final_url || undefined,
        title: row.title || undefined,
        status: (row.status || 'accepted') as JobState,
        version: Number(row.version || 1),
        attempts: Number(row.attempts || 0),
        maxAttempts: Number(row.max_attempts || 3),
        leaseOwner: row.lease_owner || undefined,
        leaseExpiresAt: row.lease_expires_at ? Number(row.lease_expires_at) : undefined,
        vkAttachment: row.vk_attachment || undefined,
        deliveryCheckpoint: row.delivery_checkpoint || undefined,
        failureCategory: (row.failure_category as JobFailureCategory) || undefined,
        safeErrorMessage: row.safe_error_message || undefined,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        expiresAt: Number(row.expires_at)
      };
    });
  }

  public async checkAndConsumeRateLimit(
    userId: number,
    limit: number,
    windowMs: number
  ): Promise<RateLimitResult> {
    return await this.driver.tableClient.withSession(async (session) => {
      const now = Date.now();
      const cutoff = now - windowMs;

      const countQuery = `
        DECLARE $user_id AS Int64;
        DECLARE $cutoff AS Int64;
        SELECT count(*) AS total_count FROM rate_limits
        WHERE user_id = $user_id AND timestamp > $cutoff;
      `;

      const res = await session.executeQuery(countQuery, {
        '$user_id': TypedValues.int64(userId),
        '$cutoff': TypedValues.int64(cutoff)
      }, AUTO_TX);

      const rows = TypedData.createNativeObjects(res.resultSets[0]) as unknown as Array<{ total_count: any }>;
      const total = Number(rows[0]?.total_count || 0);

      if (total >= limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil(windowMs / 1000)
        };
      }

      const insertQuery = `
        DECLARE $user_id AS Int64;
        DECLARE $timestamp AS Int64;
        UPSERT INTO rate_limits (user_id, timestamp) VALUES ($user_id, $timestamp);
      `;

      await session.executeQuery(insertQuery, {
        '$user_id': TypedValues.int64(userId),
        '$timestamp': TypedValues.int64(now)
      }, AUTO_TX);

      return { allowed: true };
    });
  }

  public async getSettings(): Promise<AppSettings> {
    const now = Date.now();
    if (this.settingsCache && this.settingsCache.expiresAt > now) {
      return this.settingsCache.data;
    }

    try {
      const settings = await this.driver.tableClient.withSession(async (session) => {
        const query = `SELECT * FROM \`Settings\`;`;
        const res = await session.executeQuery(query, {}, AUTO_TX);
        const rows = TypedData.createNativeObjects(res.resultSets[0]) as unknown as Array<Record<string, any>>;

        const map: Record<string, string> = {};
        for (const row of rows) {
          if (row.key !== undefined && row.value !== undefined) {
            map[String(row.key)] = String(row.value);
          } else if (row.Key !== undefined && row.Value !== undefined) {
            map[String(row.Key)] = String(row.Value);
          } else {
            for (const [colKey, colVal] of Object.entries(row)) {
              if (colVal !== null && colVal !== undefined) {
                map[colKey] = String(colVal);
              }
            }
          }
        }

        return parseSettingsMap(map);
      });

      this.settingsCache = {
        data: settings,
        expiresAt: now + this.settingsCacheTtlMs
      };
      return settings;
    } catch {
      return parseSettingsMap({});
    }
  }

  public async setSetting(key: string, value: string): Promise<void> {
    await this.driver.tableClient.withSession(async (session) => {
      const query = `
        DECLARE $key AS Utf8;
        DECLARE $value AS Utf8;
        UPSERT INTO \`Settings\` (key, value) VALUES ($key, $value);
      `;
      await session.executeQuery(query, {
        '$key': TypedValues.utf8(key),
        '$value': TypedValues.utf8(value)
      }, AUTO_TX);
    });

    this.settingsCache = undefined;
  }

  public async deleteSetting(key: string): Promise<void> {
    await this.driver.tableClient.withSession(async (session) => {
      const query = `
        DECLARE $key AS Utf8;
        DELETE FROM \`Settings\` WHERE key = $key;
      `;
      await session.executeQuery(query, {
        '$key': TypedValues.utf8(key)
      }, AUTO_TX);
    });

    this.settingsCache = undefined;
  }

  public async getUser(userId: number): Promise<UserRecord | null> {
    return await this.driver.tableClient.withSession(async (session) => {
      const query = `
        DECLARE $id AS Int64;
        SELECT ID, CreatedAt, LastAccess, RequestsCount, Status, ProfileLink
        FROM \`Users\`
        WHERE ID = $id;
      `;
      const res = await session.executeQuery(query, {
        '$id': TypedValues.int64(userId)
      }, AUTO_TX);

      const rows = TypedData.createNativeObjects(res.resultSets[0]) as unknown as Array<Record<string, any>>;
      if (!rows || rows.length === 0) return null;

      const row = rows[0];
      return {
        id: Number(row.ID),
        createdAt: row.CreatedAt,
        lastAccess: row.LastAccess,
        requestsCount: Number(row.RequestsCount || 0),
        status: Number(row.Status ?? 0),
        profileLink: String(row.ProfileLink || `https://vk.com/id${userId}`)
      };
    });
  }

  public async upsertUserAccess(userId: number, profileLink?: string): Promise<UserRecord> {
    const link = profileLink || `https://vk.com/id${userId}`;
    return await this.driver.tableClient.withSession(async (session) => {
      const selectQuery = `
        DECLARE $id AS Int64;
        SELECT ID, CreatedAt, LastAccess, RequestsCount, Status, ProfileLink
        FROM \`Users\`
        WHERE ID = $id;
      `;
      const selRes = await session.executeQuery(selectQuery, {
        '$id': TypedValues.int64(userId)
      }, AUTO_TX);

      const rows = TypedData.createNativeObjects(selRes.resultSets[0]) as unknown as Array<Record<string, any>>;
      const existing = rows && rows.length > 0 ? rows[0] : null;

      const newCount = existing ? Number(existing.RequestsCount || 0) + 1 : 1;
      const status = existing ? Number(existing.Status ?? 0) : 0;

      const upsertQuery = `
        DECLARE $id AS Int64;
        DECLARE $requests_count AS Int64;
        DECLARE $status AS Int32;
        DECLARE $profile_link AS Utf8;

        UPSERT INTO \`Users\` (ID, CreatedAt, LastAccess, RequestsCount, Status, ProfileLink)
        VALUES (
          $id,
          COALESCE((SELECT CreatedAt FROM \`Users\` WHERE ID = $id), CurrentUtcTimestamp()),
          CurrentUtcTimestamp(),
          $requests_count,
          $status,
          $profile_link
        );
      `;

      await session.executeQuery(upsertQuery, {
        '$id': TypedValues.int64(userId),
        '$requests_count': TypedValues.int64(newCount),
        '$status': TypedValues.int32(status),
        '$profile_link': TypedValues.utf8(link)
      }, AUTO_TX);

      return {
        id: userId,
        createdAt: existing?.CreatedAt || new Date(),
        lastAccess: new Date(),
        requestsCount: newCount,
        status,
        profileLink: link
      };
    });
  }

  public async setUserStatus(userId: number, status: number): Promise<void> {
    await this.driver.tableClient.withSession(async (session) => {
      const query = `
        DECLARE $id AS Int64;
        DECLARE $status AS Int32;
        UPDATE \`Users\` SET Status = $status WHERE ID = $id;
      `;
      await session.executeQuery(query, {
        '$id': TypedValues.int64(userId),
        '$status': TypedValues.int32(status)
      }, AUTO_TX);
    });
  }

  public async getUserRoles(userId: number): Promise<number[]> {
    return await this.driver.tableClient.withSession(async (session) => {
      const query = `
        DECLARE $user AS Int64;
        SELECT Role FROM \`Roles\` WHERE User = $user;
      `;
      const res = await session.executeQuery(query, {
        '$user': TypedValues.int64(userId)
      }, AUTO_TX);

      const rows = TypedData.createNativeObjects(res.resultSets[0]) as unknown as Array<{ Role?: any }>;
      return rows.map(r => Number(r.Role)).filter(n => !isNaN(n));
    });
  }

  public async addUserRole(userId: number, role: number): Promise<void> {
    await this.driver.tableClient.withSession(async (session) => {
      const query = `
        DECLARE $user AS Int64;
        DECLARE $role AS Int32;
        UPSERT INTO \`Roles\` (User, Role) VALUES ($user, $role);
      `;
      await session.executeQuery(query, {
        '$user': TypedValues.int64(userId),
        '$role': TypedValues.int32(role)
      }, AUTO_TX);
    });

    this.roleUsersCache.delete(role);
  }

  public async removeUserRole(userId: number, role: number): Promise<void> {
    await this.driver.tableClient.withSession(async (session) => {
      const query = `
        DECLARE $user AS Int64;
        DECLARE $role AS Int32;
        DELETE FROM \`Roles\` WHERE User = $user AND Role = $role;
      `;
      await session.executeQuery(query, {
        '$user': TypedValues.int64(userId),
        '$role': TypedValues.int32(role)
      }, AUTO_TX);
    });

    this.roleUsersCache.delete(role);
  }

  public async getUsersByRole(role: number): Promise<number[]> {
    const now = Date.now();
    const cached = this.roleUsersCache.get(role);
    if (cached && cached.expiresAt > now) {
      return cached.users;
    }

    try {
      const users = await this.driver.tableClient.withSession(async (session) => {
        const query = `
          DECLARE $role AS Int32;
          SELECT User FROM \`Roles\` WHERE Role = $role;
        `;
        const res = await session.executeQuery(query, {
          '$role': TypedValues.int32(role)
        }, AUTO_TX);

        const rows = TypedData.createNativeObjects(res.resultSets[0]) as unknown as Array<{ User?: any }>;
        const userList = rows.map(r => Number(r.User)).filter(n => !isNaN(n));
        return Array.from(new Set(userList));
      });

      this.roleUsersCache.set(role, { users, expiresAt: now + this.roleUsersCacheTtlMs });
      return users;
    } catch {
      return [];
    }
  }
}
