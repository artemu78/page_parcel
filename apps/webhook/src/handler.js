"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookHandler = void 0;
const node_crypto_1 = require("node:crypto");
const jobs_1 = require("@readable-web/jobs");
const search_js_1 = require("./search.js");
const observability_1 = require("@readable-web/observability");
const vk_1 = require("@readable-web/vk");
const safe_network_1 = require("@readable-web/safe-network");
const observability_2 = require("@readable-web/observability");
const commands_js_1 = require("./commands.js");
class WebhookHandler {
    searchStore;
    searchClient;
    jobStore;
    outboxService;
    vkClient;
    validationOptions;
    logger;
    maxRequestsPerMinute;
    constructor(options) {
        this.searchStore = options.searchStore ?? new jobs_1.MemorySearchStore();
        this.searchClient = options.searchClient ?? new search_js_1.SerperClient();
        this.jobStore = options.jobStore;
        this.outboxService = options.outboxService;
        this.vkClient = options.vkClient;
        this.validationOptions = options.validationOptions;
        this.logger = (options.logger ?? observability_2.defaultLogger).child({ component: 'WebhookHandler' });
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
        if (event.type === 'message_allow') {
            const userId = event.object?.user_id;
            if (Number.isSafeInteger(userId) && userId > 0) {
                this.greetAllowedUser(userId, event.event_id).catch(err => this.logger.exception(err, 'Send welcome message'));
            }
        }
        if ((0, vk_1.isMessageNewEvent)(event)) {
            const msg = event.object.message;
            // Process event asynchronously or safely within callback deadline
            this.processMessageEvent(event).catch((err) => {
                this.logger.exception(err, 'Error processing message event');
            }).finally(() => (0, observability_1.flushExceptionReports)());
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
        if (peerId !== fromId)
            return; // Private messages only.
        const user = await this.jobStore.getUser?.(fromId);
        if (user?.status === 1) {
            await this.sendReply(peerId, '⛔ Ваш доступ к сервису заблокирован администратором.', `blocked_${msg.id}`);
            return;
        }
        const command = (0, commands_js_1.parseCommand)(text, msg.payload);
        if (!user && command.type === 'unrecognized' && text.trim() && !text.trim().startsWith('/')) {
            await this.sendReply(peerId, commands_js_1.GREETING_MESSAGE, `welcome_${fromId}`);
        }
        if (command.type !== 'read')
            await this.jobStore.upsertUserAccess?.(fromId, `https://vk.com/id${fromId}`);
        switch (command.type) {
            case 'start':
                await this.sendReply(peerId, commands_js_1.GREETING_MESSAGE, `start_${msg.id}`);
                break;
            case 'search-read': {
                const session = await this.searchStore.get(command.searchId);
                if (!session || session.ownerId !== fromId || session.peerId !== peerId || session.status !== 'completed' || !session.results[command.index]) {
                    await this.sendReply(peerId, 'Эта выдача недоступна. Отправьте новый поисковый запрос.', `read_missing_${msg.id}`);
                }
                else {
                    await this.handleReadCommand(peerId, fromId, session.results[command.index].url, event.event_id || `msg_${peerId}_${msg.id}`);
                }
                break;
            }
            case 'more': {
                const session = await this.searchStore.get(command.searchId);
                if (!session || session.ownerId !== fromId || session.peerId !== peerId || session.status !== 'completed' || command.offset >= session.results.length) {
                    await this.sendReply(peerId, 'Эта выдача недоступна. Отправьте новый поисковый запрос.', `more_missing_${msg.id}`);
                }
                else {
                    const page = (0, search_js_1.searchPage)(session, command.offset);
                    await this.sendReply(peerId, page.message, `more_${session.id}_${command.offset}`, page.keyboard);
                }
                break;
            }
            case 'help': {
                await this.sendReply(peerId, commands_js_1.HELP_MESSAGE, `help_${msg.id}`);
                break;
            }
            case 'version': {
                await this.sendReply(peerId, (0, commands_js_1.formatVersionMessage)(), `version_${msg.id}`);
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
                if (!text.trim() || text.trim().startsWith('/')) {
                    await this.sendReply(peerId, commands_js_1.HELP_MESSAGE, `unrec_${msg.id}`);
                }
                else {
                    await this.handleSearch(peerId, fromId, text.trim(), event.event_id || `msg_${peerId}_${msg.id}`);
                }
                break;
            }
        }
    }
    async greetAllowedUser(userId, eventId) {
        const user = await this.jobStore.getUser?.(userId);
        if (user?.status === 1)
            return;
        await this.sendReply(userId, commands_js_1.GREETING_MESSAGE, `welcome_${eventId || userId}`);
    }
    async handleSearch(peerId, ownerId, query, eventId) {
        if (query.length > 500) {
            await this.sendReply(peerId, 'Сократите запрос до 500 символов.', `query_long_${eventId}`);
            return;
        }
        const session = { id: (0, node_crypto_1.createHash)('sha256').update(`${ownerId}:${peerId}:${eventId}`).digest('hex'),
            ownerId, peerId, query, createdAt: Date.now(), status: 'pending', results: [] };
        const admission = await this.searchStore.begin(session);
        if (admission.duplicate)
            return;
        if (!admission.session) {
            await this.sendReply(peerId, `Новый поиск доступен через ${admission.retryAfterSeconds} сек. Кнопкой «Ещё» можно пользоваться без ожидания.`, `search_limit_${eventId}`);
            return;
        }
        try {
            session.results = (await this.searchClient.search(query)).slice(0, 20);
            session.status = 'completed';
        }
        catch (err) {
            this.logger.exception(err, 'Serper search failed');
            session.status = 'failed';
        }
        await this.searchStore.finish(session);
        if (session.status === 'failed') {
            await this.sendReply(peerId, 'Поиск временно недоступен. Попробуйте позже.', `search_failed_${session.id}`);
            return;
        }
        const page = (0, search_js_1.searchPage)(session, 0);
        await this.sendReply(peerId, page.message, `search_${session.id}`, page.keyboard);
    }
    async handleReadCommand(peerId, fromId, inputUrl, eventId) {
        // 1. Inexpensive URL syntax & safety check
        let validatedUrl;
        try {
            validatedUrl = (0, safe_network_1.validateUrlSyntax)(inputUrl);
        }
        catch (err) {
            this.logger.warn('Rejected URL command');
            observability_2.metrics.failedJobsTotal.inc({ category: 'INVALID_URL' });
            await this.sendReply(peerId, `❌ Ошибка в адресе: ${err.message}\n\nПожалуйста, укажите корректный публичный URL (http или https).`, `invalid_${eventId}`);
            return;
        }
        // 2. Check blocked user status and update access metrics
        const userRecord = await this.jobStore.getUser?.(fromId).catch(err => { this.logger.exception(err, 'Read user access'); return null; });
        if (userRecord && userRecord.status === 1) {
            this.logger.warn(`Rejected request from blocked user ${fromId}`);
            await this.sendReply(peerId, '⛔ Ваш доступ к сервису заблокирован администратором.', `blocked_${eventId}`);
            return;
        }
        await this.jobStore.upsertUserAccess?.(fromId, `https://vk.com/id${fromId}`).catch(err => { this.logger.exception(err, 'Update user access'); });
        // 3. Rate limiting (atomic)
        const rateCheck = await this.jobStore.checkAndConsumeRateLimit(fromId, this.maxRequestsPerMinute, 60000);
        if (!rateCheck.allowed) {
            this.logger.warn(`User ${fromId} exceeded rate limit`);
            observability_2.metrics.blockedDestinationsTotal.inc({ reason: 'RATE_LIMIT_EXCEEDED' });
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
        observability_2.metrics.acceptedJobsTotal.inc();
        this.logger.info(`Accepted job ${job.id} for user ${fromId}`);
        // 4. Outbox publication to queue
        try {
            await this.outboxService.publishWithOutbox(job.id);
        }
        catch (err) {
            this.logger.exception(err, 'Outbox publication failed for job');
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
                statusText = `❌ Ошибка: ${job.safeErrorMessage || 'Не удалось обработать страницу'}\n\n(Извините нас, мы уже получили уведомление об ошибке и будем исправлять, мы вам сообщим.)`;
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
            if (keyboard) {
                const errMsg = err?.message || '';
                const errCode = err?.errorCode;
                if (errCode === 912 || errMsg.includes('912')) {
                    this.logger.info(`Retrying message without keyboard due to VK error 912`);
                    try {
                        const randomId = (0, vk_1.generateStableRandomId)(seed);
                        await this.vkClient.sendMessage({
                            peerId,
                            message,
                            randomId
                        });
                        return;
                    }
                    catch (retryErr) {
                        this.logger.exception(retryErr, 'Failed to send fallback VK message');
                        return;
                    }
                }
            }
            this.logger.exception(err, 'Failed to send VK message');
        }
    }
}
exports.WebhookHandler = WebhookHandler;
//# sourceMappingURL=handler.js.map