export type JobState =
  | 'accepted'
  | 'queued'
  | 'rendering'
  | 'uploading'
  | 'delivering'
  | 'completed'
  | 'failed';

export type JobFailureCategory =
  | 'INVALID_URL'
  | 'SSRF_BLOCKED'
  | 'CONTENT_UNSUPPORTED'
  | 'SIZE_EXCEEDED'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'VK_API_ERROR'
  | 'RETRIES_EXHAUSTED'
  | 'INTERNAL_ERROR';

export interface Job {
  id: string;
  ownerId: number;
  peerId: number;
  eventId: string;
  submittedUrl: string;
  finalUrl?: string;
  title?: string;
  status: JobState;
  version: number;
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  vkAttachment?: string; // e.g. doc12345_67890
  deliveryCheckpoint?: string;
  failureCategory?: JobFailureCategory;
  safeErrorMessage?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface CreateJobParams {
  id?: string;
  ownerId: number;
  peerId: number;
  eventId: string;
  submittedUrl: string;
  maxAttempts?: number;
  ttlSeconds?: number;
}

export interface JobQueueMessage {
  jobId: string;
  ownerId: number;
  peerId: number;
  submittedUrl: string;
  createdAt: number;
  attempts: number;
}

export interface AppSettings {
  adminId?: number;
  errorListeners: number[];
  maxRequestsPerJob?: number;
  raw: Record<string, string>;
}

export function parseSettingsMap(map: Map<string, string> | Record<string, string>): AppSettings {
  const raw: Record<string, string> = map instanceof Map ? Object.fromEntries(map.entries()) : { ...map };

  const getVal = (name: string): string | undefined => {
    const target = name.toLowerCase();
    for (const [k, v] of Object.entries(raw)) {
      if (k.toLowerCase() === target) {
        return v;
      }
    }
    return undefined;
  };

  let maxRequestsPerJob: number | undefined;
  const maxReqRaw = getVal('MaxRequestsPerJob') ?? getVal('MaxRequests');
  if (maxReqRaw !== undefined && maxReqRaw.trim().length > 0) {
    const parsed = Number(maxReqRaw.trim());
    if (!isNaN(parsed) && parsed > 0) {
      maxRequestsPerJob = parsed;
    }
  }

  let adminId: number | undefined;
  const adminIdRaw = getVal('AdminID');
  if (adminIdRaw !== undefined && adminIdRaw.trim().length > 0) {
    const parsed = Number(adminIdRaw.trim());
    if (!isNaN(parsed) && parsed > 0) {
      adminId = parsed;
    }
  }

  let errorListeners: number[] = [];
  const errorListenersRaw = getVal('ErrorListeners');
  if (errorListenersRaw !== undefined && errorListenersRaw.trim().length > 0) {
    const trimmed = errorListenersRaw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          errorListeners = parsed
            .map(x => Number(x))
            .filter(n => !isNaN(n) && n > 0);
        }
      } catch {
        // Fall back to comma-separated if json parse fails
      }
    }
    if (errorListeners.length === 0) {
      errorListeners = trimmed
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(x => Number(x.trim()))
        .filter(n => !isNaN(n) && n > 0);
    }
  }

  // Deduplicate
  errorListeners = Array.from(new Set(errorListeners));

  return {
    adminId,
    errorListeners,
    maxRequestsPerJob,
    raw
  };
}

export interface UserRecord {
  id: number;
  createdAt: number | Date;
  lastAccess: number | Date;
  requestsCount: number;
  status: number; // 0 - enabled, 1 - blocked
  profileLink: string;
}

export interface RoleRecord {
  user: number;
  role: number;
}
