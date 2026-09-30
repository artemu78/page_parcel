import { defaultLogger, configureExceptionReporting, installRuntimeExceptionHandlers, flushExceptionReports } from '@readable-web/observability';
import { VkApiClient } from '@readable-web/vk';
import { MemorySearchStore, MemoryJobStore, YdbJobStore, SqsQueueClient, MemoryQueueClient, OutboxService } from '@readable-web/jobs';
import { WebhookHandler } from './handler.js';
import { WebhookServer } from './server.js';
import { OpenRouterClient } from './openrouter.js';

async function bootstrap() {
  configureExceptionReporting('webhook');
  installRuntimeExceptionHandlers('webhook');
  const logger = defaultLogger.child({ service: 'webhook' });

  const groupId = Number.parseInt(process.env.VK_GROUP_ID || '0', 10);
  const secret = process.env.VK_SECRET || '';
  const confirmationCode = process.env.VK_CONFIRMATION_CODE || '';
  const vkToken = process.env.VK_GROUP_TOKEN || '';
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  const ymqQueueUrl = process.env.YMQ_QUEUE_URL || '';
  const ydbEndpoint = process.env.YDB_ENDPOINT;
  const ydbDatabase = process.env.YDB_DATABASE;

  let jobStore;
  let searchStore;
  if (ydbEndpoint && ydbDatabase) {
    logger.info(`Using YdbJobStore with endpoint ${ydbEndpoint} and database ${ydbDatabase}`);
    const ydbStore = new YdbJobStore({ endpoint: ydbEndpoint, database: ydbDatabase });
    const exceptionOutbox = ydbStore.exceptionOutbox();
    await exceptionOutbox.init();
    configureExceptionReporting('webhook', exceptionOutbox);
    await ydbStore.init();
    searchStore = ydbStore.searchStore();
    await searchStore.init();
    jobStore = ydbStore;
  } else {
    logger.warn('YDB not configured, using MemoryJobStore (local/dev mode)');
    jobStore = new MemoryJobStore();
    searchStore = new MemorySearchStore();
  }

  const ymqAccessKey = process.env.YMQ_ACCESS_KEY;
  const ymqSecretKey = process.env.YMQ_SECRET_KEY;

  let queueClient;
  if (ymqQueueUrl) {
    queueClient = new SqsQueueClient({
      queueUrl: ymqQueueUrl,
      region: process.env.AWS_REGION || 'ru-central1',
      credentials: (ymqAccessKey && ymqSecretKey) ? {
        accessKeyId: ymqAccessKey,
        secretAccessKey: ymqSecretKey
      } : undefined
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

  const openRouterClient = openRouterApiKey
    ? new OpenRouterClient({
        apiKey: openRouterApiKey,
        logger
      })
    : undefined;

  if (openRouterClient) {
    logger.info('OpenRouter client initialized');
  } else {
    logger.warn('OPENROUTER_API_KEY not configured; optional OpenRouter client unavailable');
  }

  const handler = new WebhookHandler({
    jobStore,
    outboxService,
    searchStore,
    vkClient,
    openRouterClient,
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
    await flushExceptionReports();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch(async (err) => {
  defaultLogger.child({ service: 'webhook' }).exception(err, 'Startup failure');
  await flushExceptionReports();
  process.exit(1);
});
