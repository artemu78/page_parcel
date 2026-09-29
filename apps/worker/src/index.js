"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const observability_1 = require("@readable-web/observability");
const vk_1 = require("@readable-web/vk");
const jobs_1 = require("@readable-web/jobs");
const job_processor_js_1 = require("./job-processor.js");
const server_js_1 = require("./server.js");
async function bootstrap() {
    const logger = observability_1.defaultLogger.child({ service: 'worker' });
    const vkToken = process.env.VK_GROUP_TOKEN || '';
    const triggerSecret = process.env.TRIGGER_SECRET;
    const ydbEndpoint = process.env.YDB_ENDPOINT;
    const ydbDatabase = process.env.YDB_DATABASE;
    let jobStore;
    if (ydbEndpoint && ydbDatabase) {
        logger.info(`Using YdbJobStore with endpoint ${ydbEndpoint} and database ${ydbDatabase}`);
        const ydbStore = new jobs_1.YdbJobStore({ endpoint: ydbEndpoint, database: ydbDatabase });
        await ydbStore.init();
        jobStore = ydbStore;
    }
    else {
        logger.warn('YDB not configured, using MemoryJobStore (local/dev mode)');
        jobStore = new jobs_1.MemoryJobStore();
    }
    const vkClient = vkToken ? new vk_1.VkApiClient({ token: vkToken }) : undefined;
    const processor = new job_processor_js_1.JobProcessor({
        jobStore,
        vkClient,
        logger
    });
    const server = new server_js_1.WorkerServer({
        processor,
        logger,
        triggerSecret
    });
    await server.start();
    const shutdown = async (signal) => {
        logger.info(`Received ${signal}, shutting down Worker Server...`);
        await server.stop();
        await processor.close();
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
bootstrap().catch((err) => {
    observability_1.defaultLogger.error(`Fatal worker startup error: ${err.message}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map