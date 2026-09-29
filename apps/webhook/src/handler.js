"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookHandler = void 0;
const vk_1 = require("@readable-web/vk");
const safe_network_1 = require("@readable-web/safe-network");
const observability_1 = require("@readable-web/observability");
const commands_js_1 = require("./commands.js");
class WebhookHandler {
    jobStore;
    outboxService;
    vkClient;
    validationOptions;
    logger;
    maxRequestsPerMinute;
    constructor(options) {
        this.jobStore = options.jobStore;
        this.outboxService = options.outboxService;
        this.vkClient = options.vkClient;
        this.validationOptions = options.validationOptions;
        this.logger = (options.logger ?? observability_1.defaultLogger).child({ component: 'WebhookHandler' });
        this.maxRequestsPerMinute = options.maxUserRequestsPerMinute ?? 10;
    }
    async handleRequest(body) {
        const validation = (0, vk_1.validateCallbackPayload)(body, this.validationOptions);
        if (!validation.valid) {
            this.logger.warn(`Callback validation rejected: ${validation.error}`);
            return { statusCode: validation.statusCode, body: validation.error };
        }
        if (validation.isConfirmation) {
            this.logger.info('Returning confirmation code');
            return { statusCode: 200, body: validation.response };
        }
        const event = validation.event;
        if ((0, vk_1.isMessageNewEvent)(event)) {
            const msg = event.object.message;
            // Process event asynchronously or safely within callback deadline
            this.processMessageEvent(event).catch((err) => {
                this.logger.error(`Error processing message event: ${err.message}`);
            });
        }
        // Acknowledge accepted event immediately with plain-text 'ok'
        return { statusCode: 200, body: 'ok' };
    }
    async processMessageEvent(event) {
        const msg = event.object.message;
        const fromId = msg.from_id;
        const peerId = msg.peer_id;
        const text = msg.text || '';
        // Ignore messages sent by group itself
        if (fromId < 0)
            return;
        const command = (0, commands_js_1.parseCommand)(text, msg.payload);
        switch (command.type) {
            case 'help': {
                await this.sendReply(peerId, commands_js_1.HELP_MESSAGE, `help_${msg.id}`);
                break;
            }
            case 'status': {
                await this.handleStatusCommand(peerId, fromId, command.jobId, msg.id);
                break;
            }
            case 'read': {
                await this.handleReadCommand(peerId, fromId, command.url, event.event_id || `msg_${msg.id}`);
                break;
            }
            case 'unrecognized': {
                await this.sendReply(peerId, `Неизвестная команда. Отправьте /read <URL> для создания PDF или /help для справки.`, `unrec_${msg.id}`);
                break;
            }
        }
    }
    async handleReadCommand(peerId, fromId, inputUrl, eventId) {
        // 1. Inexpensive URL syntax & safety check
        let validatedUrl;
        try {
            validatedUrl = (0, safe_network_1.validateUrlSyntax)(inputUrl);
        }
        catch (err) {
            this.logger.warn(`Rejected URL command: ${err.message}`);
            observability_1.metrics.failedJobsTotal.inc({ category: 'INVALID_URL' });
            await this.sendReply(peerId, `❌ Ошибка в адресе: ${err.message}\n\nПожалуйста, укажите корректный публичный URL (http или https).`, `invalid_${eventId}`);
            return;
        }
        // 2. Check blocked user status and update access metrics
        const userRecord = await this.jobStore.getUser?.(fromId).catch(() => null);
        if (userRecord && userRecord.status === 1) {
            this.logger.warn(`Rejected request from blocked user ${fromId}`);
            await this.sendReply(peerId, '⛔ Ваш доступ к сервису заблокирован администратором.', `blocked_${eventId}`);
            return;
        }
        await this.jobStore.upsertUserAccess?.(fromId, `https://vk.com/id${fromId}`).catch(() => { });
        // 3. Rate limiting (atomic)
        const rateCheck = await this.jobStore.checkAndConsumeRateLimit(fromId, this.maxRequestsPerMinute, 60000);
        if (!rateCheck.allowed) {
            this.logger.warn(`User ${fromId} exceeded rate limit`);
            observability_1.metrics.blockedDestinationsTotal.inc({ reason: 'RATE_LIMIT_EXCEEDED' });
            await this.sendReply(peerId, `⏳ Слишком много запросов. Пожалуйста, подождите ${rateCheck.retryAfterSeconds} сек.`, `ratelimit_${eventId}`);
            return;
        }
        // 3. Durable persistence & deduplication
        const { job, isDuplicate } = await this.jobStore.createJobIfNotExist({
            ownerId: fromId,
            peerId,
            eventId,
            submittedUrl: validatedUrl.normalizedUrl
        });
        if (isDuplicate) {
            this.logger.debug(`Duplicate event ${eventId} ignored`);
            return;
        }
        observability_1.metrics.acceptedJobsTotal.inc();
        this.logger.info(`Accepted job ${job.id} for user ${fromId}`);
        // 4. Outbox publication to queue
        try {
            await this.outboxService.publishWithOutbox(job.id);
        }
        catch (err) {
            this.logger.error(`Outbox publication failed for job ${job.id}: ${err.message}`);
            // Job remains in accepted state for background sweeper retry
        }
        // 5. Send asynchronous preparation confirmation to user with inline status button and text description
        const statusKeyboard = (0, vk_1.createStatusKeyboard)(job.id);
        await this.sendReply(peerId, `⏳ Готовим удобную версию статьи...\nИдентификатор задания: ${job.id}\n\nВы можете проверить статус с помощью кнопки ниже или командой:\n/status ${job.id}`, `prep_${job.id}`, statusKeyboard);
    }
    async handleStatusCommand(peerId, fromId, jobId, messageId) {
        const job = await this.jobStore.getJob(jobId);
        if (!job) {
            await this.sendReply(peerId, `❌ Задание с ID ${jobId} не найдено или истек срок хранения (24 часа).`, `status_notfound_${messageId}`);
            return;
        }
        // Strict ownership verification
        if (job.ownerId !== fromId) {
            this.logger.warn(`Unauthorized status check for job ${jobId} by user ${fromId}`);
            await this.sendReply(peerId, `⛔ Доступ запрещен: вы можете проверять статус только собственных заданий.`, `status_forbidden_${messageId}`);
            return;
        }
        const createdStr = new Date(job.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
        let statusText = '';
        switch (job.status) {
            case 'accepted':
            case 'queued':
                statusText = 'В очереди на обработку';
                break;
            case 'rendering':
                statusText = 'Загрузка страницы и создание PDF';
                break;
            case 'uploading':
                statusText = 'Загрузка PDF в документы ВКонтакте';
                break;
            case 'delivering':
                statusText = 'Отправка документа пользователю';
                break;
            case 'completed':
                statusText = '✅ Успешно завершено';
                break;
            case 'failed':
                statusText = `❌ Ошибка: ${job.safeErrorMessage || 'Не удалось обработать страницу'}`;
                break;
        }
        const reply = `📄 Статус задания ${job.id}:
• Состояние: ${statusText}
• Попытка: ${job.attempts}/${job.maxAttempts}
• Создано: ${createdStr} (MSK)
• URL: ${job.submittedUrl}`;
        await this.sendReply(peerId, reply, `status_resp_${messageId}`);
    }
    async sendReply(peerId, message, seed, keyboard) {
        if (!this.vkClient)
            return;
        try {
            const randomId = (0, vk_1.generateStableRandomId)(seed);
            await this.vkClient.sendMessage({
                peerId,
                message,
                randomId,
                keyboard
            });
        }
        catch (err) {
            this.logger.warn(`Failed to send VK message: ${err.message}`);
        }
    }
}
exports.WebhookHandler = WebhookHandler;
//# sourceMappingURL=handler.js.map