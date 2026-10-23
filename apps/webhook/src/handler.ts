import { MODEL_OWNER_ID, selectedModel, defaultModelFor, modelKeyboard } from './models.js';
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
import { JobStore, OutboxService, AiQueueMessage } from '@readable-web/jobs';
import { Logger, defaultLogger, metrics, UpstreamResponseError } from '@readable-web/observability';
import { parseCommand, GREETING_MESSAGE, HELP_MESSAGE, formatVersionMessage } from './commands.js';
import { OpenRouterClient, splitMessage } from './openrouter.js';

export interface WebhookHandlerOptions {
  publishAiRequest?: (message: AiQueueMessage) => Promise<void>;
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
  private publishAiRequest?: (message: AiQueueMessage) => Promise<void>;
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
    this.publishAiRequest = options.publishAiRequest;
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

    try {
      if (event.type === 'message_allow') {
        const userId = (event as unknown as { object?: { user_id?: number } }).object?.user_id;
        if (Number.isSafeInteger(userId) && userId! > 0) await this.greetAllowedUser(userId!, event.event_id);
      }
      if (isMessageNewEvent(event)) await this.processMessageEvent(event);
    } catch (err) {
      this.logger.exception(err, 'Error processing message event');
      if (isMessageNewEvent(event)) {
        const msg = event.object.message;
        if (msg.from_id > 0 && msg.peer_id === msg.from_id) {
          await this.sendReply(msg.peer_id,
            '⚠️ Не удалось обработать сообщение. Ошибка передана в диагностику. Повторите запрос или отправьте /ai-status.',
            `event_failed_${msg.peer_id}_${msg.id}`, createModeKeyboard('ai', msg.from_id === MODEL_OWNER_ID));
        }
      }
    } finally {
      await flushExceptionReports();
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
      case 'model': {
        if (fromId !== MODEL_OWNER_ID) {
          await this.sendReply(peerId, 'Выбор модели недоступен.', `model_denied_${msg.id}`);
          break;
        }
        if (!command.model) {
          const state = await this.conversationStore.get(fromId);
          await this.sendReply(peerId, 'Выберите модель ИИ:', `models_${msg.id}`, modelKeyboard(state.modelKey));
          break;
        }
        const selected = selectedModel(fromId, command.model);
        if (command.model !== 'default' && !selected) {
          await this.sendReply(peerId, 'Эта модель недоступна. Используйте /model.', `model_invalid_${msg.id}`);
          break;
        }
        const updated = await this.changeConversation(fromId, state => {
          if (state.recentEvents.includes(eventId)) return false;
          state.recentEvents = [...state.recentEvents, eventId].slice(-100);
          state.modelKey = selected?.key;
          state.mode = 'ai';
          // Fence the old completion so its answer cannot arrive under a new model.
          if (state.pending) delete state.lastAiRequest;
          delete state.pending;
          return true;
        });
        if (updated) await this.sendReply(peerId,
          `💬 Модель: ${selected?.label ?? 'По умолчанию'}. Контекст сохранён.`, `model_${eventId}`);
        break;
      }
      case 'mode':
      case 'new-chat': {
        const updated = await this.changeConversation(fromId, state => {
          if (state.recentEvents.includes(eventId)) return false;
          state.recentEvents = [...state.recentEvents, eventId].slice(-100);
          if (command.type === 'mode') state.mode = command.mode;
          else { state.mode = 'ai'; state.history = []; state.historyUpdatedAt = 0; delete state.pending; delete state.lastAiRequest; }
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

      case 'ai-status': {
        let state = await this.conversationStore.get(fromId);
        if (state.pending && state.pending.expiresAt <= Date.now()) {
          const expiredId = state.pending.eventId;
          const cleared = await this.changeConversation(fromId, current => {
            if (current.pending?.eventId !== expiredId || current.pending.expiresAt > Date.now()) return false;
            delete current.pending;
            current.lastAiRequest = { eventId: expiredId, stage: 'interrupted', updatedAt: Date.now() };
            return true;
          });
          if (cleared) {
            this.logger.exception(new Error('AI request interrupted before completion'), 'AI request interrupted', { requestId: expiredId });
            state = cleared;
          }
        }
        const trace = state.lastAiRequest;
        const stage = state.pending && state.pending.expiresAt <= Date.now() ? 'interrupted' : trace?.stage;
        const labels = { queued: 'в очереди', processing: 'ожидание ответа ИИ', delivering: 'отправка ответа в VK',
          completed: 'ответ отправлен', failed: 'ошибка обработки или доставки', interrupted: 'обработка прервана или истекло время ожидания' };
        const id = state.pending?.eventId ?? trace?.eventId;
        await this.sendReply(peerId, `💬 Режим: ${state.mode === 'ai' ? 'ИИ' : 'поиск'}.\nСостояние: ${stage ? labels[stage] : 'запросов ещё нет'}.${trace?.failureCategory ? `\nПричина: ${trace.failureCategory}` : ''}${trace?.httpStatus ? `\nHTTP: ${trace.httpStatus}` : ''}${id ? `\nКод: ${id}` : ''}`,
          `ai_status_${msg.id}`, createModeKeyboard(state.mode, fromId === MODEL_OWNER_ID));
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
    if (!this.openRouterClient && !this.publishAiRequest) {
      await this.sendReply(peerId, '💬 Чат с ИИ временно недоступен. Можно переключиться на поиск.', `ai_unavailable_${eventId}`);
      return;
    }
    let busy = false;
    let interruptedId: string | undefined;
    const reserved = await this.changeConversation(ownerId, state => {
      busy = false;
      if (state.recentEvents.includes(eventId)) return false;
      if (state.pending && state.pending.expiresAt > Date.now()) { busy = true; return false; }
      interruptedId = state.pending?.eventId;
      state.recentEvents = [...state.recentEvents, eventId].slice(-100);
      state.pending = { eventId, expiresAt: Date.now() + (this.publishAiRequest ? 300000 : 90000),
        ...(this.publishAiRequest ? { prompt, stage: 'queued' as const } : {}) };
      state.lastAiRequest = { eventId, stage: 'queued', updatedAt: Date.now() };
      return true;
    });
    if (!reserved) {
      const current = await this.conversationStore.get(ownerId);
      if (this.publishAiRequest && current.pending?.eventId === eventId && current.pending.stage === 'queued') {
        // Recover a callback retry after persistence but before queue publication/acknowledgment.
        await this.sendTyping(peerId, eventId);
        await this.publishAiRequest({ kind: 'ai', ownerId, eventId });
      }
      if (busy) await this.sendReply(peerId, '💬 Дождитесь ответа ИИ, затем отправьте следующее сообщение.', `ai_busy_${eventId}`);
      return;
    }
    if (interruptedId) this.logger.exception(new Error('Previous AI request expired before completion'), 'AI request interrupted', { requestId: interruptedId });
    if (this.publishAiRequest) {
      try {
        await this.sendTyping(peerId, eventId);
        await this.publishAiRequest({ kind: 'ai', ownerId, eventId });
      } catch (error) {
        this.logger.exception(error, 'Queue AI request', { requestId: eventId });
        await this.sendReply(peerId, `💬 Не удалось поставить запрос ИИ в очередь. Повторите сообщение.\nКод: ${eventId}`,
          `ai_queue_failed_${eventId}`, createModeKeyboard('ai', ownerId === MODEL_OWNER_ID));
        await this.changeConversation(ownerId, state => {
          if (state.pending?.eventId !== eventId) return false;
          delete state.pending;
          state.recentEvents = state.recentEvents.filter(id => id !== eventId);
          state.lastAiRequest = { eventId, stage: 'failed', updatedAt: Date.now(), failureCategory: 'queue_failure' };
          return true;
        });
      }
      return;
    }
    await this.runAiChat(peerId, ownerId, prompt, eventId, reserved);
  }

  /** Called only by the authenticated queue-triggered worker; queue contains no conversation text. */
  public async processQueuedAiRequest(message: AiQueueMessage): Promise<{ retryable: boolean }> {
    try {
      return await this.processAiQueueReference(message);
    } catch (error) {
      this.logger.exception(error, 'Read or claim queued AI request', { requestId: message.eventId });
      await this.sendReply(message.ownerId, `💬 Не удалось прочитать или обработать запрос ИИ. Повторите позже.\nКод: ${message.eventId}`,
        `ai_storage_failed_${message.eventId}`, createModeKeyboard('ai', message.ownerId === MODEL_OWNER_ID));
      return { retryable: true };
    }
  }

  private async processAiQueueReference(message: AiQueueMessage): Promise<{ retryable: boolean }> {
    const { ownerId, eventId } = message;
    const current = await this.conversationStore.get(ownerId);
    if (current.pending?.eventId !== eventId) return { retryable: false };
    if (current.pending.expiresAt <= Date.now()) {
      this.logger.exception(new Error('AI request interrupted before completion'), 'AI request interrupted', { requestId: eventId });
      await this.sendReply(ownerId, `💬 Обработка запроса ИИ прервана или истекло время ожидания. Отправьте сообщение ещё раз.\nКод: ${eventId}`,
        `ai_interrupted_${eventId}`, createModeKeyboard(current.mode, ownerId === MODEL_OWNER_ID));
      await this.changeConversation(ownerId, state => {
        if (state.pending?.eventId !== eventId) return false;
        delete state.pending;
        state.lastAiRequest = { eventId, stage: 'interrupted', updatedAt: Date.now() };
        return true;
      });
      return { retryable: false };
    }
    if (current.pending.stage === 'processing') return { retryable: true };
    const user = await this.jobStore.getUser?.(ownerId);
    if (user?.status === 1) return { retryable: false };
    const reserved = await this.changeConversation(ownerId, state => {
      if (state.pending?.eventId !== eventId || state.pending.stage !== 'queued') return false;
      state.pending.stage = 'processing';
      state.pending.expiresAt = Date.now() + 90000;
      state.lastAiRequest = { eventId, stage: 'processing', updatedAt: Date.now() };
      return true;
    });
    if (!reserved) return { retryable: true };
    try {
      if (!this.openRouterClient) throw new Error('AI worker provider is not configured');
      if (!reserved.pending?.prompt) throw new Error('AI queued request prompt is unavailable');
      await this.runAiChat(ownerId, ownerId, reserved.pending.prompt, eventId, reserved);
      return { retryable: false };
    } catch (error) {
      this.logger.exception(error, 'Process queued AI request', { requestId: eventId });
      await this.sendReply(ownerId, `💬 Не удалось обработать запрос ИИ. Повторите сообщение.\nКод: ${eventId}`,
        `ai_worker_failed_${eventId}`, createModeKeyboard(current.mode, ownerId === MODEL_OWNER_ID));
      return { retryable: true };
    }
  }

  private async runAiChat(peerId: number, ownerId: number, prompt: string, eventId: string, reserved: Conversation): Promise<void> {
    let phase: 'settings' | 'provider' | 'delivery' = 'settings';
    let typingTimer: ReturnType<typeof setInterval> | undefined;
    let typingRefresh: Promise<void> | undefined;
    const stopTyping = async () => {
      clearInterval(typingTimer);
      typingTimer = undefined;
      await typingRefresh;
    };
    try {
      const rate = await this.jobStore.checkAndConsumeRateLimit(ownerId, this.maxRequestsPerMinute, 60000);
      if (!rate.allowed) {
        await this.sendReply(peerId, `💬 Слишком много запросов. Подождите ${rate.retryAfterSeconds} сек.`, `ai_limit_${eventId}`);
        return;
      }
      const settings = await this.jobStore.getSettings();
      if (!this.openRouterClient) throw new Error('AI provider is not configured');
      const selection = selectedModel(ownerId, reserved.modelKey);
      phase = 'provider';
      await this.sendTyping(peerId, eventId);
      // Only renew during the active worker invocation; never leave a post-response timer.
      typingTimer = setInterval(() => {
        if (typingRefresh) return;
        typingRefresh = this.refreshAiTyping(peerId, ownerId, eventId).finally(() => { typingRefresh = undefined; });
      }, 7000);
      typingTimer.unref();
      const reply = await this.openRouterClient.complete({ prompt, history: reserved.history,
        model: selection?.model ?? defaultModelFor(ownerId, settings.openRouterModel),
        reasoningEffort: selection?.reasoningEffort, baseUrl: settings.openRouterBaseUrl,
        proxyUrl: settings.openRouterProxy, maxTokens: 2000,
        systemPrompt: 'Ты полезный собеседник. Отвечай на языке пользователя. В этом режиме у тебя нет доступа к веб-поиску; не утверждай, что проверил актуальные сведения в интернете.' });
      await stopTyping();
      if (!reply.trim()) throw new UpstreamResponseError('Empty AI completion', 'OpenRouter', 200);
      const finished = await this.changeConversation(ownerId, state => {
        if (state.pending?.eventId !== eventId || state.pending.expiresAt <= Date.now()) return false;
        state.history = trimHistory([...reserved.history, { role: 'user', content: prompt }, { role: 'assistant', content: reply }]);
        state.historyUpdatedAt = Date.now();
        state.lastAiRequest = { eventId, stage: 'delivering', updatedAt: Date.now() };
        return true;
      });
      if (!finished) {
        const state = await this.conversationStore.get(ownerId);
        if (state.pending?.eventId === eventId) throw new Error('AI request deadline expired');
        return; // A reset or a newer reservation superseded this reply.
      }
      phase = 'delivery';
      for (const [index, chunk] of splitMessage(reply, 3900).entries()) {
        if (!await this.sendReply(peerId, `💬 Ответ ИИ\n\n${chunk}`, `ai_${eventId}_${index}`)) {
          throw new Error('AI response delivery failed');
        }
      }
      await this.changeConversation(ownerId, state => {
        if (state.lastAiRequest?.eventId !== eventId) return false;
        if (state.pending?.eventId === eventId) delete state.pending;
        state.lastAiRequest = { eventId, stage: 'completed', updatedAt: Date.now() };
        return true;
      });
    } catch (error) {
      await stopTyping();
      this.logger.exception(error, 'AI chat completion failed', { requestId: eventId });
      const current = await this.conversationStore.get(ownerId);
      if (current.pending?.eventId === eventId || current.lastAiRequest?.eventId === eventId && current.lastAiRequest.stage === 'delivering') {
        await this.sendReply(peerId, `💬 Не удалось получить или отправить ответ ИИ. Попробуйте позже.\nКод: ${eventId}`, `ai_failed_${eventId}`);
      }
      await this.changeConversation(ownerId, state => {
        if (state.lastAiRequest?.eventId !== eventId) return false;
        state.lastAiRequest = { eventId, stage: 'failed', updatedAt: Date.now(),
          failureCategory: phase === 'provider' ? 'provider_failure' : phase === 'delivery' ? 'delivery_failure' : 'internal_error',
          ...(error instanceof UpstreamResponseError ? { httpStatus: error.statusCode } : {}) };
        return true;
      });
    } finally {
      await stopTyping();
      await this.changeConversation(ownerId, state => {
        if (state.pending?.eventId !== eventId) return false;
        delete state.pending;
        if (state.lastAiRequest?.eventId !== eventId || state.lastAiRequest.stage !== 'failed') {
          state.lastAiRequest = { eventId, stage: 'failed', updatedAt: Date.now() };
        }
        return true;
      });
    }
  }

  private async sendTyping(peerId: number, eventId: string): Promise<void> {
    if (!this.vkClient?.setTyping) return;
    try { await this.vkClient.setTyping(peerId); }
    catch (error) { this.logger.exception(error, 'Set VK typing activity', { requestId: eventId }); }
  }

  private async refreshAiTyping(peerId: number, ownerId: number, eventId: string): Promise<void> {
    try {
      const state = await this.conversationStore.get(ownerId);
      if (state.pending?.eventId === eventId && state.pending.expiresAt > Date.now()) {
        await this.sendTyping(peerId, eventId);
      }
    } catch (error) { this.logger.exception(error, 'Read AI typing reservation', { requestId: eventId }); }
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

  private async sendReply(peerId: number, message: string, seed: string, keyboard?: string): Promise<boolean> {
    if (!this.vkClient) return false;

    try {
      if (!keyboard) {
        try { keyboard = createModeKeyboard((await this.conversationStore.get(peerId)).mode, peerId === MODEL_OWNER_ID); }
        catch (error) { this.logger.exception(error, 'Read reply keyboard settings'); }
      }
      const randomId = generateStableRandomId(seed);
      await this.vkClient.sendMessage({
        peerId,
        message,
        randomId,
        keyboard
      });
      return true;
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
            return true;
          } catch (retryErr) {
            this.logger.exception(retryErr, 'Failed to send fallback VK message');
            return false;
          }
        }
      }
      this.logger.exception(err, 'Failed to send VK message');
      return false;
    }
  }
}
