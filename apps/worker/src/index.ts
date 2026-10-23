import { WebhookHandler } from '@readable-web/webhook/dist/handler.js';
import { OpenRouterClient } from '@readable-web/webhook/dist/openrouter.js';
import { defaultLogger, configureExceptionReporting, installRuntimeExceptionHandlers, flushExceptionReports } from '@readable-web/observability';
import { VkApiClient } from '@readable-web/vk';
import { MemoryJobStore, YdbJobStore, MemoryConversationStore, MemoryQueueClient, OutboxService } from '@readable-web/jobs';
import { JobProcessor } from './job-processor.js';
import { WorkerServer } from './server.js';

async function bootstrap() {
  configureExceptionReporting('worker');
  installRuntimeExceptionHandlers('worker');
  const logger = defaultLogger.child({ service: 'worker' });

  const vkToken = process.env.VK_GROUP_TOKEN || '';
  const triggerSecret = process.env.TRIGGER_SECRET;
  const ydbEndpoint = process.env.YDB_ENDPOINT;
  const ydbDatabase = process.env.YDB_DATABASE;

  let jobStore;
  let conversationStore;
  if (ydbEndpoint && ydbDatabase) {
    logger.info(`Using YdbJobStore with endpoint ${ydbEndpoint} and database ${ydbDatabase}`);
    const ydbStore = new YdbJobStore({ endpoint: ydbEndpoint, database: ydbDatabase });
    const exceptionOutbox = ydbStore.exceptionOutbox();
    await exceptionOutbox.init();
    configureExceptionReporting('worker', exceptionOutbox);
    await ydbStore.init();
    conversationStore = ydbStore.conversationStore();
    await conversationStore.init();
    jobStore = ydbStore;
  } else {
    logger.warn('YDB not configured, using MemoryJobStore (local/dev mode)');
    jobStore = new MemoryJobStore();
    conversationStore = new MemoryConversationStore();
  }
  const vkClient = vkToken ? new VkApiClient({ token: vkToken }) : undefined;

  const processor = new JobProcessor({
    jobStore,
    vkClient,
    logger
  });

  const aiHandler = new WebhookHandler({
    jobStore, conversationStore, vkClient, logger,
    outboxService: new OutboxService({ jobStore, queueClient: new MemoryQueueClient() }),
    openRouterClient: process.env.OPENROUTER_API_KEY ? new OpenRouterClient({ apiKey: process.env.OPENROUTER_API_KEY, logger }) : undefined,
    validationOptions: { expectedGroupId: 0, confirmationCode: '' }
  });
  const server = new WorkerServer({
    processAiRequest: message => aiHandler.processQueuedAiRequest(message),
    processor,
    logger,
    triggerSecret
  });

  await server.start();

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down Worker Server...`);
    await server.stop();
    await processor.close();
    await flushExceptionReports();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch(async (err) => {
  defaultLogger.child({ service: 'worker' }).exception(err, 'Startup failure');
  await flushExceptionReports();
  process.exit(1);
});
