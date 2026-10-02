import { createHash } from 'node:crypto';
import { MemoryConversationStore, ConversationStore, Conversation, HISTORY_TTL_MS, trimHistory, MemorySearchStore, SearchStore, SearchSession } from '@readable-web/jobs';
import { SerperClient, SearchClient, searchPage } from './search.js';
import { flushExceptionReports } from '@readable-web/observability';
import {
  CallbackValidationOptions,
  validateCallbackPayload,
  isMessageNewEvent,
  VkApiClient,
  generateStableRandomId,
  VkMessageNewEvent,
  createModeKeyboard,
  createStatusKeyboard
} from '@readable-web/vk';
import { validateUrlSyntax } from '@readable-web/safe-network';
import { JobStore, OutboxService } from '@readable-web/jobs';
import { Logger, defaultLogger, metrics, UpstreamResponseError } from '@readable-web/observability';
import { parseCommand, GREETING_MESSAGE, HELP_MESSAGE, formatVersionMessage } from './commands.js';
import { OpenRouterClient, splitMessage } from './openrouter.js';

export interface WebhookHandlerOptions {
  conversationStore?: ConversationStore;
  searchStore?: SearchStore;
  searchClient?: SearchClient;
  jobStore: JobStore;
  outboxService: OutboxService;
  vkClient?: VkApiClient;
  openRouterClient?: OpenRouterClient;
  validationOptions: CallbackValidationOptions;
  logger?: Logger;
  maxUserRequestsPerMinute?: number;
}

export class WebhookHandler {
  private conversationStore: ConversationStore;
  private openRouterClient?: OpenRouterClient;
  private searchStore: SearchStore;
  private searchClient: SearchClient;
  private jobStore: JobStore;
  private outboxService: OutboxService;
  private vkClient?: VkApiClient;
  private validationOptions: CallbackValidationOptions;
  private logger: Logger;
  private maxRequestsPerMinute: number;

  constructor(options: WebhookHandlerOptions) {
    this.conversationStore = options.conversationStore ?? new MemoryConversationStore();
    this.openRouterClient = options.openRouterClient;
    this.searchStore = options.searchStore ?? new MemorySearchStore();
    this.searchClient = options.searchClient ?? new SerperClient();
    this.jobStore = options.jobStore;
    this.outboxService = options.outboxService;
    this.vkClient = options.vkClient;
    this.validationOptions = options.validationOptions;
    this.logger = (options.logger ?? defaultLogger).child({ component: 'WebhookHandler' });
    this.maxRequestsPerMinute = options.maxUserRequestsPerMinute ?? 10;
  }

  public async handleRequest(
    body: unknown
  ): Promise<{ statusCode: number; body: string }> {
    const validation = validateCallbackPayload(body, this.validationOptions);

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
      const userId = (event as unknown as { object?: { user_id?: number } }).object?.user_id;
      if (Number.isSafeInteger(userId) && userId! > 0) {
        this.greetAllowedUser(userId!, event.event_id).catch(err => this.logger.exception(err, 'Send welcome message'));
      }
    }
    if (isMessageNewEvent(event)) {
      const msg = event.object.message;
      // Process event asynchronously or safely within callback deadline
      this.processMessageEvent(event).catch((err) => {
        this.logger.exception(err, 'Error processing message event');
      }).finally(() => flushExceptionReports());
    }

    // Acknowledge accepted event immediately with plain-text 'ok'
    return { statusCode: 200, body: 'ok' };
  }

  private async processMessageEvent(event: VkMessageNewEvent): Promise<void> {
    const msg = event.object.message;
    const fromId = msg.from_id;
    const peerId = msg.peer_id;
    const text = msg.text || '';

    // Ignore messages sent by group itself
    if (fromId < 0) return;

    if (peerId !== fromId) return; // Private messages only.
    const user = await this.jobStore.getUser?.(fromId);
    if (user?.status === 1) {
      await this.sendReply(peerId, '⛔ Ваш доступ к сервису заблокирован администратором.', `blocked_${msg.id}`);
      return;
    }
    const command = parseCommand(text, msg.payload);
    const eventId = createHash('sha256').update(`${fromId}:${event.event_id || `msg_${peerId}_${msg.id}`}`).digest('hex');
    if (!user && command.type === 'unrecognized' && text.trim() && !text.trim().startsWith('/')) {
      await this.sendReply(peerId, GREETING_MESSAGE, `welcome_${fromId}`);
    }
    if (command.type !== 'read') await this.jobStore.upsertUserAccess?.(fromId, `https://vk.com/id${fromId}`);

    switch (command.type) {
      case 'mode':
      case 'new-chat': {
        const updated = await this.changeConversation(fromId, state => {
          if (state.recentEvents.includes(eventId)) return false;
          state.recentEvents = [...state.recentEvents, eventId].slice(-100);
          if (command.type === 'mode') state.mode = command.mode;
          else { state.mode = 'ai'; state.history = []; state.historyUpdatedAt = 0; delete state.pending; }
          return true;
        });
        if (updated) await this.sendReply(peerId,
          command.type === 'new-chat' ? '💬 Новый разговор начат. Что обсудим?' :
          command.mode === 'ai' ? '💬 Чат с ИИ включён. Что обсудим?' : '🔎 Поиск включён. Что найти?',
          `mode_${eventId}`);
        break;
      }

      case 'start':
        await this.sendReply(peerId, GREETING_MESSAGE, `start_${msg.id}`);
        break;
      case 'search-read': {
        const session = await this.searchStore.get(command.searchId);
        if (!session || session.ownerId !== fromId || session.peerId !== peerId || session.status !== 'completed' || !session.results[command.index]) {
          await this.sendReply(peerId, 'Эта выдача недоступна. Отправьте новый поисковый запрос.', `read_missing_${msg.id}`);
        } else {
          await this.handleReadCommand(peerId, fromId, session.results[command.index].url, event.event_id || `msg_${peerId}_${msg.id}`);
        }
        break;
      }
      case 'more': {
        const session = await this.searchStore.get(command.searchId);
        if (!session || session.ownerId !== fromId || session.peerId !== peerId || session.status !== 'completed' || command.offset >= session.results.length) {
          await this.sendReply(peerId, 'Эта выдача недоступна. Отправьте новый поисковый запрос.', `more_missing_${msg.id}`);
        } else {
          const page = searchPage(session, command.offset);
          await this.sendReply(peerId, page.message, `more_${session.id}_${command.offset}`, page.keyboard);
        }
        break;
      }
      case 'help': {
        await this.sendReply(peerId, HELP_MESSAGE, `help_${msg.id}`);
        break;
      }

      case 'version': {
        await this.sendReply(peerId, formatVersionMessage(), `version_${msg.id}`);
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
          await this.sendReply(peerId, HELP_MESSAGE, `unrec_${msg.id}`);
        } else {
          const state = await this.conversationStore.get(fromId);
          if (state.mode === 'ai') {
            await this.handleAiChat(peerId, fromId, text.trim(), eventId);
          } else {
            const admitted = await this.changeConversation(fromId, current => {
              if (current.recentEvents.includes(eventId)) return false;
              current.recentEvents = [...current.recentEvents, eventId].slice(-100);
              return true;
            });
            if (!admitted) break;
            if (state.version === 0 && user) await this.sendReply(peerId, '🔎 Поиск включён. Что найти?', `initial_mode_${eventId}`);
            await this.handleSearch(peerId, fromId, text.trim(), event.event_id || `msg_${peerId}_${msg.id}`);
          }
        }
        break;
      }
    }
  }

  /** Serializable CAS retries keep mode changes independent of pending AI replies. */
  private async changeConversation(ownerId: number, change: (state: Conversation) => boolean): Promise<Conversation | null> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const state = await this.conversationStore.get(ownerId);
      if (state.historyUpdatedAt + HISTORY_TTL_MS <= Date.now()) state.history = [];
      if (!change(state)) return null;
      if (await this.conversationStore.compareAndSet(ownerId, state.version, state)) return state;
    }
    throw new Error('Conversation update contention');
  }

  private async handleAiChat(peerId: number, ownerId: number, prompt: string, eventId: string): Promise<void> {
    if (prompt.length > 4000) {
      await this.sendReply(peerId, '💬 Сократите сообщение до 4000 символов.', `ai_long_${eventId}`);
      return;
    }
    if (!this.openRouterClient) {
      await this.sendReply(peerId, '💬 Чат с ИИ временно недоступен. Можно переключиться на поиск.', `ai_unavailable_${eventId}`);
      return;
    }
    let busy = false;
    const reserved = await this.changeConversation(ownerId, state => {
      busy = false;
      if (state.recentEvents.includes(eventId)) return false;
      if (state.pending && state.pending.expiresAt > Date.now()) { busy = true; return false; }
      state.recentEvents = [...state.recentEvents, eventId].slice(-100);
      state.pending = { eventId, expiresAt: Date.now() + 90000 };
      return true;
    });
    if (!reserved) {
      if (busy) await this.sendReply(peerId, '💬 Дождитесь ответа ИИ, затем отправьте следующее сообщение.', `ai_busy_${eventId}`);
      return;
    }
    try {
      const rate = await this.jobStore.checkAndConsumeRateLimit(ownerId, this.maxRequestsPerMinute, 60000);
      if (!rate.allowed) {
        await this.sendReply(peerId, `💬 Слишком много запросов. Подождите ${rate.retryAfterSeconds} сек.`, `ai_limit_${eventId}`);
        return;
      }
      const settings = await this.jobStore.getSettings();
      const reply = await this.openRouterClient.complete({ prompt, history: reserved.history,
        model: settings.openRouterModel, baseUrl: settings.openRouterBaseUrl,
        proxyUrl: settings.openRouterProxy, maxTokens: 2000,
        systemPrompt: 'Ты полезный собеседник. Отвечай на языке пользователя. В этом режиме у тебя нет доступа к веб-поиску; не утверждай, что проверил актуальные сведения в интернете.' });
      if (!reply.trim()) throw new UpstreamResponseError('Empty AI completion', 'OpenRouter', 200);
      const finished = await this.changeConversation(ownerId, state => {
        if (state.pending?.eventId !== eventId || state.pending.expiresAt <= Date.now()) return false;
        state.history = trimHistory([...reserved.history, { role: 'user', content: prompt }, { role: 'assistant', content: reply }]);
        state.historyUpdatedAt = Date.now();
        delete state.pending;
        return true;
      });
      if (!finished) return; // A reset or a newer reservation superseded this reply.
      for (const [index, chunk] of splitMessage(reply, 3900).entries()) {
        await this.sendReply(peerId, `💬 Ответ ИИ\n\n${chunk}`, `ai_${eventId}_${index}`);
      }
    } catch (error) {
      this.logger.exception(error, 'AI chat completion failed');
      const current = await this.conversationStore.get(ownerId);
      if (current.pending?.eventId === eventId) {
        await this.sendReply(peerId, '💬 Не удалось получить ответ ИИ. Попробуйте позже.', `ai_failed_${eventId}`);
      }
    } finally {
      await this.changeConversation(ownerId, state => {
        if (state.pending?.eventId !== eventId) return false;
        delete state.pending;
        return true;
      });
    }
  }

  private async greetAllowedUser(userId: number, eventId?: string): Promise<void> {
    const user = await this.jobStore.getUser?.(userId);
    if (user?.status === 1) return;
    await this.sendReply(userId, GREETING_MESSAGE, `welcome_${eventId || userId}`);
  }

  private async handleSearch(peerId: number, ownerId: number, query: string, eventId: string): Promise<void> {
    if (query.length > 500) {
      await this.sendReply(peerId, 'Сократите запрос до 500 символов.', `query_long_${eventId}`);
      return;
    }
    const session: SearchSession = { id: createHash('sha256').update(`${ownerId}:${peerId}:${eventId}`).digest('hex'),
      ownerId, peerId, query, createdAt: Date.now(), status: 'pending', results: [] };
    const admission = await this.searchStore.begin(session);
    if (admission.duplicate) return;
    if (!admission.session) {
      await this.sendReply(peerId, `Новый поиск доступен через ${admission.retryAfterSeconds} сек. Кнопкой «Ещё» можно пользоваться без ожидания.`, `search_limit_${eventId}`);
      return;
    }
    try {
      session.results = (await this.searchClient.search(query)).slice(0, 20);
      session.status = 'completed';
    } catch (err) {
      this.logger.exception(err, 'Serper search failed');
      session.status = 'failed';
    }
    await this.searchStore.finish(session);
    if (session.status === 'failed') {
      await this.sendReply(peerId, 'Поиск временно недоступен. Попробуйте позже.', `search_failed_${session.id}`);
      return;
    }
    const page = searchPage(session, 0);
    await this.sendReply(peerId, page.message, `search_${session.id}`, page.keyboard);
  }

  private async handleReadCommand(
    peerId: number,
    fromId: number,
    inputUrl: string,
    eventId: string
  ): Promise<void> {
    // 1. Inexpensive URL syntax & safety check
    let validatedUrl: ReturnType<typeof validateUrlSyntax>;
    try {
      validatedUrl = validateUrlSyntax(inputUrl);
    } catch (err) {
      this.logger.warn('Rejected URL command');
      metrics.failedJobsTotal.inc({ category: 'INVALID_URL' });
      await this.sendReply(
        peerId,
        `❌ Ошибка в адресе: ${(err as Error).message}\n\nПожалуйста, укажите корректный публичный URL (http или https).`,
        `invalid_${eventId}`
      );
      return;
    }

    // 2. Check blocked user status and update access metrics
    const userRecord = await this.jobStore.getUser?.(fromId).catch(err => { this.logger.exception(err, 'Read user access'); return null; });
    if (userRecord && userRecord.status === 1) {
      this.logger.warn(`Rejected request from blocked user ${fromId}`);
      await this.sendReply(
        peerId,
        '⛔ Ваш доступ к сервису заблокирован администратором.',
        `blocked_${eventId}`
      );
      return;
    }

    await this.jobStore.upsertUserAccess?.(fromId, `https://vk.com/id${fromId}`).catch(err => { this.logger.exception(err, 'Update user access'); });

    // 3. Rate limiting (atomic)
    const rateCheck = await this.jobStore.checkAndConsumeRateLimit(
      fromId,
      this.maxRequestsPerMinute,
      60000
    );

    if (!rateCheck.allowed) {
      this.logger.warn(`User ${fromId} exceeded rate limit`);
      metrics.blockedDestinationsTotal.inc({ reason: 'RATE_LIMIT_EXCEEDED' });
      await this.sendReply(
        peerId,
        `⏳ Слишком много запросов. Пожалуйста, подождите ${rateCheck.retryAfterSeconds} сек.`,
        `ratelimit_${eventId}`
      );
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

    metrics.acceptedJobsTotal.inc();
    this.logger.info(`Accepted job ${job.id} for user ${fromId}`);

    // 4. Outbox publication to queue
    try {
      await this.outboxService.publishWithOutbox(job.id);
    } catch (err) {
      this.logger.exception(err, 'Outbox publication failed for job');
      // Job remains in accepted state for background sweeper retry
    }

    // 5. Send asynchronous preparation confirmation to user with inline status button and text description
    const statusKeyboard = createStatusKeyboard(job.id);
    await this.sendReply(
      peerId,
      `⏳ Готовим удобную версию статьи...\nИдентификатор задания: ${job.id}\n\nВы можете проверить статус с помощью кнопки ниже или командой:\n/status ${job.id}`,
      `prep_${job.id}`,
      statusKeyboard
    );
  }

  private async handleStatusCommand(
    peerId: number,
    fromId: number,
    jobId: string,
    messageId: number
  ): Promise<void> {
    const job = await this.jobStore.getJob(jobId);

    if (!job) {
      await this.sendReply(
        peerId,
        `❌ Задание с ID ${jobId} не найдено или истек срок хранения (24 часа).`,
        `status_notfound_${messageId}`
      );
      return;
    }

    // Strict ownership verification
    if (job.ownerId !== fromId) {
      this.logger.warn(`Unauthorized status check for job ${jobId} by user ${fromId}`);
      await this.sendReply(
        peerId,
        `⛔ Доступ запрещен: вы можете проверять статус только собственных заданий.`,
        `status_forbidden_${messageId}`
      );
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

  private async sendReply(peerId: number, message: string, seed: string, keyboard?: string): Promise<void> {
    if (!this.vkClient) return;

    try {
      keyboard ??= createModeKeyboard((await this.conversationStore.get(peerId)).mode);
      const randomId = generateStableRandomId(seed);
      await this.vkClient.sendMessage({
        peerId,
        message,
        randomId,
        keyboard
      });
    } catch (err) {
      if (keyboard) {
        const errMsg = (err as Error)?.message || '';
        const errCode = (err as any)?.errorCode;
        if (errCode === 912 || errMsg.includes('912')) {
          this.logger.info(`Retrying message without keyboard due to VK error 912`);
          try {
            const randomId = generateStableRandomId(seed);
            await this.vkClient.sendMessage({
              peerId,
              message,
              randomId
            });
            return;
          } catch (retryErr) {
            this.logger.exception(retryErr, 'Failed to send fallback VK message');
            return;
          }
        }
      }
      this.logger.exception(err, 'Failed to send VK message');
    }
  }
}
