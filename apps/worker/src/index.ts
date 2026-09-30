import { defaultLogger, configureExceptionReporting, installRuntimeExceptionHandlers, flushExceptionReports } from '@readable-web/observability';
import { VkApiClient } from '@readable-web/vk';
import { MemoryJobStore, YdbJobStore } from '@readable-web/jobs';
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
  if (ydbEndpoint && ydbDatabase) {
    logger.info(`Using YdbJobStore with endpoint ${ydbEndpoint} and database ${ydbDatabase}`);
    const ydbStore = new YdbJobStore({ endpoint: ydbEndpoint, database: ydbDatabase });
    const exceptionOutbox = ydbStore.exceptionOutbox();
    await exceptionOutbox.init();
    configureExceptionReporting('worker', exceptionOutbox);
    await ydbStore.init();
    jobStore = ydbStore;
  } else {
    logger.warn('YDB not configured, using MemoryJobStore (local/dev mode)');
    jobStore = new MemoryJobStore();
  }
  const vkClient = vkToken ? new VkApiClient({ token: vkToken }) : undefined;

  const processor = new JobProcessor({
    jobStore,
    vkClient,
    logger
  });

  const server = new WorkerServer({
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
