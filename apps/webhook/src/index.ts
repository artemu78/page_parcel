import { defaultLogger } from '@readable-web/observability';
import { VkApiClient } from '@readable-web/vk';
import { MemoryJobStore, SqsQueueClient, MemoryQueueClient, OutboxService } from '@readable-web/jobs';
import { WebhookHandler } from './handler.js';
import { WebhookServer } from './server.js';

async function bootstrap() {
  const logger = defaultLogger.child({ service: 'webhook' });

  const groupId = Number.parseInt(process.env.VK_GROUP_ID || '0', 10);
  const secret = process.env.VK_SECRET || '';
  const confirmationCode = process.env.VK_CONFIRMATION_CODE || '';
  const vkToken = process.env.VK_GROUP_TOKEN || '';
  const ymqQueueUrl = process.env.YMQ_QUEUE_URL || '';

  const jobStore = new MemoryJobStore();

  let queueClient;
  if (ymqQueueUrl) {
    queueClient = new SqsQueueClient({
      queueUrl: ymqQueueUrl,
      region: process.env.AWS_REGION || 'ru-central1'
    });
  } else {
    logger.warn('YMQ_QUEUE_URL not configured, using MemoryQueueClient (local/dev mode)');
    queueClient = new MemoryQueueClient();
  }

  const outboxService = new OutboxService({
    jobStore,
    queueClient,
    logger
  });

  const vkClient = vkToken ? new VkApiClient({ token: vkToken }) : undefined;

  const handler = new WebhookHandler({
    jobStore,
    outboxService,
    vkClient,
    validationOptions: {
      expectedGroupId: groupId,
      expectedSecret: secret || undefined,
      confirmationCode
    },
    logger
  });

  const server = new WebhookServer({
    handler,
    logger
  });

  await server.start();

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down Webhook Server...`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  defaultLogger.error(`Fatal webhook startup error: ${err.message}`);
  process.exit(1);
});
