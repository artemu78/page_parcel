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
