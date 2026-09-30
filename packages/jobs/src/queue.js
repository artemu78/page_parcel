"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryQueueClient = exports.SqsQueueClient = void 0;
const client_sqs_1 = require("@aws-sdk/client-sqs");
const observability_1 = require("@readable-web/observability");
class SqsQueueClient {
    client;
    queueUrl;
    logger;
    constructor(options) {
        this.queueUrl = options.queueUrl;
        this.logger = (options.logger ?? observability_1.defaultLogger).child({ component: 'SqsQueue' });
        this.client = new client_sqs_1.SQSClient({
            region: options.region ?? 'ru-central1',
            endpoint: options.endpoint ?? 'https://message-queue.api.cloud.yandex.net',
            credentials: options.credentials
        });
    }
    async publishJob(job) {
        const payload = {
            jobId: job.id,
            ownerId: job.ownerId,
            peerId: job.peerId,
            submittedUrl: job.submittedUrl,
            createdAt: job.createdAt,
            attempts: job.attempts
        };
        const isFifo = this.queueUrl.endsWith('.fifo');
        const command = new client_sqs_1.SendMessageCommand({
            QueueUrl: this.queueUrl,
            MessageBody: JSON.stringify(payload),
            ...(isFifo ? {
                MessageDeduplicationId: `${job.id}_${job.attempts}`,
                MessageGroupId: `user_${job.ownerId}`
            } : {})
        });
        try {
            await this.client.send(command);
            this.logger.debug(`Published job ${job.id} to YMQ`);
        }
        catch (err) {
            this.logger.exception(err, 'Failed to publish job  to YMQ');
            throw err;
        }
    }
}
exports.SqsQueueClient = SqsQueueClient;
class MemoryQueueClient {
    messages = [];
    async publishJob(job) {
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
exports.MemoryQueueClient = MemoryQueueClient;
//# sourceMappingURL=queue.js.map