import { defaultLogger } from '@readable-web/observability';
import { VkApiClient } from '@readable-web/vk';
import { MemoryJobStore } from '@readable-web/jobs';
import { JobProcessor } from './job-processor.js';
import { WorkerServer } from './server.js';

async function bootstrap() {
  const logger = defaultLogger.child({ service: 'worker' });

  const vkToken = process.env.VK_GROUP_TOKEN || '';
  const triggerSecret = process.env.TRIGGER_SECRET;

  const jobStore = new MemoryJobStore();
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
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  defaultLogger.error(`Fatal worker startup error: ${err.message}`);
  process.exit(1);
});
