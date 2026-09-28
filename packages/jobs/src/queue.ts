import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Job, JobQueueMessage } from './types.js';
import { Logger, defaultLogger } from '@readable-web/observability';

export interface QueueClient {
  publishJob(job: Job): Promise<void>;
}

export interface SqsQueueOptions {
  queueUrl: string;
  region?: string;
  endpoint?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  logger?: Logger;
}

export class SqsQueueClient implements QueueClient {
  private client: SQSClient;
  private queueUrl: string;
  private logger: Logger;

  constructor(options: SqsQueueOptions) {
    this.queueUrl = options.queueUrl;
    this.logger = (options.logger ?? defaultLogger).child({ component: 'SqsQueue' });

    this.client = new SQSClient({
      region: options.region ?? 'ru-central1',
      endpoint: options.endpoint ?? 'https://message-queue.api.cloud.yandex.net',
      credentials: options.credentials
    });
  }

  public async publishJob(job: Job): Promise<void> {
    const payload: JobQueueMessage = {
      jobId: job.id,
      ownerId: job.ownerId,
      peerId: job.peerId,
      submittedUrl: job.submittedUrl,
      createdAt: job.createdAt,
      attempts: job.attempts
    };

    const command = new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(payload),
      MessageDeduplicationId: `${job.id}_${job.attempts}`,
      MessageGroupId: `user_${job.ownerId}`
    });

    try {
      await this.client.send(command);
      this.logger.debug(`Published job ${job.id} to YMQ`);
    } catch (err) {
      this.logger.error(`Failed to publish job ${job.id} to YMQ: ${(err as Error).message}`);
      throw err;
    }
  }
}

export class MemoryQueueClient implements QueueClient {
  public messages: JobQueueMessage[] = [];

  public async publishJob(job: Job): Promise<void> {
    this.messages.push({
      jobId: job.id,
      ownerId: job.ownerId,
      peerId: job.peerId,
      submittedUrl: job.submittedUrl,
      createdAt: job.createdAt,
      attempts: job.attempts
    });
  }
}
