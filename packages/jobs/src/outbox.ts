import { JobStore } from './store.js';
import { QueueClient } from './queue.js';
import { Logger, defaultLogger } from '@readable-web/observability';

export interface OutboxSweeperOptions {
  jobStore: JobStore;
  queueClient: QueueClient;
  logger?: Logger;
  staleAcceptedAgeMs?: number;
}

export class OutboxService {
  private jobStore: JobStore;
  private queueClient: QueueClient;
  private logger: Logger;

  constructor(options: OutboxSweeperOptions) {
    this.jobStore = options.jobStore;
    this.queueClient = options.queueClient;
    this.logger = (options.logger ?? defaultLogger).child({ component: 'OutboxService' });
  }

  public async publishWithOutbox(jobId: string): Promise<void> {
    const job = await this.jobStore.getJob(jobId);
    if (!job) {
      throw new Error(`Cannot publish non-existent job: ${jobId}`);
    }

    if (job.status !== 'accepted') {
      return; // Already published or further in lifecycle
    }

    try {
      await this.queueClient.publishJob(job);
      await this.jobStore.updateStatus(job.id, 'queued', { expectedVersion: job.version });
      this.logger.debug(`Job ${job.id} successfully published and transitioned to queued`);
    } catch (err) {
      this.logger.exception(err, 'Failed to publish job  to queue, will remain in accepted state for retry');
      throw err;
    }
  }
}
