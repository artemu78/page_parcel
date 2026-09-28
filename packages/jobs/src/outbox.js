"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutboxService = void 0;
const observability_1 = require("@readable-web/observability");
class OutboxService {
    jobStore;
    queueClient;
    logger;
    constructor(options) {
        this.jobStore = options.jobStore;
        this.queueClient = options.queueClient;
        this.logger = (options.logger ?? observability_1.defaultLogger).child({ component: 'OutboxService' });
    }
    async publishWithOutbox(jobId) {
        const job = await this.jobStore.getJob(jobId);
        if (!job) {
            throw new Error(`Cannot publish non-existent job: ${jobId}`);
        }
        if (job.status !== 'accepted') {
            return; // Already published or further in lifecycle
        }
        try {
            await this.queueClient.publishJob(job);
            await this.jobStore.updateStatus(job.id, 'queued', { expectedVersion: job.version });
            this.logger.debug(`Job ${job.id} successfully published and transitioned to queued`);
        }
        catch (err) {
            this.logger.error(`Failed to publish job ${job.id} to queue, will remain in accepted state for retry: ${err.message}`);
            throw err;
        }
    }
}
exports.OutboxService = OutboxService;
//# sourceMappingURL=outbox.js.map