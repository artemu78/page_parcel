"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const observability_1 = require("@readable-web/observability");
const vk_1 = require("@readable-web/vk");
const jobs_1 = require("@readable-web/jobs");
const handler_js_1 = require("./handler.js");
const server_js_1 = require("./server.js");
async function bootstrap() {
    const logger = observability_1.defaultLogger.child({ service: 'webhook' });
    const groupId = Number.parseInt(process.env.VK_GROUP_ID || '0', 10);
    const secret = process.env.VK_SECRET || '';
    const confirmationCode = process.env.VK_CONFIRMATION_CODE || '';
    const vkToken = process.env.VK_GROUP_TOKEN || '';
    const ymqQueueUrl = process.env.YMQ_QUEUE_URL || '';
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
    const ymqAccessKey = process.env.YMQ_ACCESS_KEY;
    const ymqSecretKey = process.env.YMQ_SECRET_KEY;
    let queueClient;
    if (ymqQueueUrl) {
        queueClient = new jobs_1.SqsQueueClient({
            queueUrl: ymqQueueUrl,
            region: process.env.AWS_REGION || 'ru-central1',
            credentials: (ymqAccessKey && ymqSecretKey) ? {
                accessKeyId: ymqAccessKey,
                secretAccessKey: ymqSecretKey
            } : undefined
        });
    }
    else {
        logger.warn('YMQ_QUEUE_URL not configured, using MemoryQueueClient (local/dev mode)');
        queueClient = new jobs_1.MemoryQueueClient();
    }
    const outboxService = new jobs_1.OutboxService({
        jobStore,
        queueClient,
        logger
    });
    const vkClient = vkToken ? new vk_1.VkApiClient({ token: vkToken }) : undefined;
    const handler = new handler_js_1.WebhookHandler({
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
    const server = new server_js_1.WebhookServer({
        handler,
        logger
    });
    await server.start();
    const shutdown = async (signal) => {
        logger.info(`Received ${signal}, shutting down Webhook Server...`);
        await server.stop();
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
bootstrap().catch((err) => {
    observability_1.defaultLogger.error(`Fatal webhook startup error: ${err.message}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map