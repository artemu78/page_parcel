"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const handler_js_1 = require("@readable-web/webhook/dist/handler.js");
const openrouter_js_1 = require("@readable-web/webhook/dist/openrouter.js");
const observability_1 = require("@readable-web/observability");
const vk_1 = require("@readable-web/vk");
const jobs_1 = require("@readable-web/jobs");
const job_processor_js_1 = require("./job-processor.js");
const server_js_1 = require("./server.js");
async function bootstrap() {
    (0, observability_1.configureExceptionReporting)('worker');
    (0, observability_1.installRuntimeExceptionHandlers)('worker');
    const logger = observability_1.defaultLogger.child({ service: 'worker' });
    const vkToken = process.env.VK_GROUP_TOKEN || '';
    const triggerSecret = process.env.TRIGGER_SECRET;
    const ydbEndpoint = process.env.YDB_ENDPOINT;
    const ydbDatabase = process.env.YDB_DATABASE;
    let jobStore;
    let conversationStore;
    if (ydbEndpoint && ydbDatabase) {
        logger.info(`Using YdbJobStore with endpoint ${ydbEndpoint} and database ${ydbDatabase}`);
        const ydbStore = new jobs_1.YdbJobStore({ endpoint: ydbEndpoint, database: ydbDatabase });
        const exceptionOutbox = ydbStore.exceptionOutbox();
        await exceptionOutbox.init();
        (0, observability_1.configureExceptionReporting)('worker', exceptionOutbox);
        await ydbStore.init();
        conversationStore = ydbStore.conversationStore();
        await conversationStore.init();
        jobStore = ydbStore;
    }
    else {
        logger.warn('YDB not configured, using MemoryJobStore (local/dev mode)');
        jobStore = new jobs_1.MemoryJobStore();
        conversationStore = new jobs_1.MemoryConversationStore();
    }
    const vkClient = vkToken ? new vk_1.VkApiClient({ token: vkToken }) : undefined;
    const processor = new job_processor_js_1.JobProcessor({
        jobStore,
        vkClient,
        logger
    });
    const aiHandler = new handler_js_1.WebhookHandler({
        jobStore, conversationStore, vkClient, logger,
        outboxService: new jobs_1.OutboxService({ jobStore, queueClient: new jobs_1.MemoryQueueClient() }),
        openRouterClient: process.env.OPENROUTER_API_KEY ? new openrouter_js_1.OpenRouterClient({ apiKey: process.env.OPENROUTER_API_KEY, logger }) : undefined,
        validationOptions: { expectedGroupId: 0, confirmationCode: '' }
    });
    const server = new server_js_1.WorkerServer({
        processAiRequest: message => aiHandler.processQueuedAiRequest(message),
        processor,
        logger,
        triggerSecret
    });
    await server.start();
    const shutdown = async (signal) => {
        logger.info(`Received ${signal}, shutting down Worker Server...`);
        await server.stop();
        await processor.close();
        await (0, observability_1.flushExceptionReports)();
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
bootstrap().catch(async (err) => {
    observability_1.defaultLogger.child({ service: 'worker' }).exception(err, 'Startup failure');
    await (0, observability_1.flushExceptionReports)();
    process.exit(1);
});
//# sourceMappingURL=index.js.map