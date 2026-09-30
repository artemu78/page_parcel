import { JobStore, Job, JobFailureCategory } from '@readable-web/jobs';
import { ValidatingEgressProxy } from '@readable-web/safe-network';
import { BrowserManager } from '@readable-web/rendering';
import { PdfGenerator, PdfFormat, PdfFormattingParams } from '@readable-web/pdf';
import { VkApiClient, generateStableRandomId } from '@readable-web/vk';
import { Logger, defaultLogger, metrics } from '@readable-web/observability';

export interface JobProcessorOptions {
  jobStore: JobStore;
  vkClient?: VkApiClient;
  workerId?: string;
  logger?: Logger;
  leaseDurationMs?: number;
  pdfFormatting?: PdfFormattingParams | PdfFormat;
}

export class JobProcessor {
  private jobStore: JobStore;
  private vkClient?: VkApiClient;
  private workerId: string;
  private logger: Logger;
  private leaseDurationMs: number;
  private browserManager: BrowserManager;
  private pdfGenerator: PdfGenerator;
  private defaultPdfFormatting?: PdfFormattingParams | PdfFormat;

  constructor(options: JobProcessorOptions) {
    this.jobStore = options.jobStore;
    this.vkClient = options.vkClient;
    this.workerId = options.workerId ?? `worker_${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
    this.logger = (options.logger ?? defaultLogger).child({ component: 'JobProcessor', workerId: this.workerId });
    this.leaseDurationMs = options.leaseDurationMs ?? 90000; // 90 seconds
    this.defaultPdfFormatting = options.pdfFormatting;
    this.browserManager = new BrowserManager(this.logger);
    this.pdfGenerator = new PdfGenerator(this.logger, undefined, options.pdfFormatting);
  }

  public async processJob(jobId: string): Promise<{ success: boolean; retryable: boolean }> {
    const startTime = Date.now();

    // 1. Atomic lease acquisition
    const job = await this.jobStore.claimJob(jobId, this.workerId, this.leaseDurationMs);
    if (!job) {
      this.logger.warn(`Could not claim job ${jobId} (already claimed, finished, or expired)`);
      return { success: true, retryable: false }; // Ack message
    }

    this.logger.info(`Claimed job ${job.id} (attempt ${job.attempts}/${job.maxAttempts})`);

    // Determine request budget per job (from dynamic settings, env, or default 500)
    let maxRequests = 500;
    const envMaxReq = process.env.MAX_REQUESTS_PER_JOB ? parseInt(process.env.MAX_REQUESTS_PER_JOB, 10) : undefined;
    if (envMaxReq && !isNaN(envMaxReq)) {
      maxRequests = envMaxReq;
    }
    try {
      if (this.jobStore.getSettings) {
        const settings = await this.jobStore.getSettings();
        if (settings.maxRequestsPerJob) {
          maxRequests = settings.maxRequestsPerJob;
        }
      }
    } catch (err) {
      this.logger.exception(err, 'Read job settings');
      // Best effort setting resolution
    }

    // Start local validating egress proxy for this job
    const proxy = new ValidatingEgressProxy({
      logger: this.logger,
      limits: { maxRequestsPerJob: maxRequests }
    });
    let proxyPort = 0;

    try {
      proxyPort = await proxy.start();
      const proxyUrl = `http://127.0.0.1:${proxyPort}`;

      // 2. Upload to VK Documents (or reuse existing checkpoint)
      let vkAttachment = job.vkAttachment;
      let finalTitle = job.title || 'Статья';
      let sourceHost = 'веб-сайт';

      if (!vkAttachment) {
        // Fetch page and extract article
        this.logger.info(`Rendering article for job ${job.id}`);
        const renderResult = await this.browserManager.renderAndExtract({
          url: job.submittedUrl,
          egressProxyUrl: proxyUrl,
          timeoutMs: 45000,
          maxRequests
        });

        finalTitle = renderResult.title;
        sourceHost = new URL(renderResult.finalUrl).hostname;

        // Update state with final URL and title
        await this.jobStore.updateStatus(job.id, 'rendering', {
          expectedVersion: job.version,
          finalUrl: renderResult.finalUrl,
          title: renderResult.title
        });

        // Determine PDF format (default is mobile, can be overridden by env, settings, or options)
        let resolvedFormat: PdfFormat = 'mobile';
        const envFormat = process.env.PDF_FORMAT;
        if (envFormat && ['mobile', 'desktop', 'a4', 'a5'].includes(envFormat.toLowerCase())) {
          resolvedFormat = envFormat.toLowerCase() as PdfFormat;
        }

        try {
          if (this.jobStore.getSettings) {
            const settings = await this.jobStore.getSettings();
            if (settings.pdfFormat && ['mobile', 'desktop', 'a4', 'a5'].includes(settings.pdfFormat.toLowerCase())) {
              resolvedFormat = settings.pdfFormat.toLowerCase() as PdfFormat;
            }
          }
        } catch (err) {
          this.logger.exception(err, 'Read PDF settings');
          // Best effort setting resolution
        }

        // Generate clean reader PDF
        this.logger.info(`Generating PDF for job ${job.id} (format: ${resolvedFormat})`);
        const pdfResult = await this.pdfGenerator.generate({
          data: {
            title: renderResult.title,
            sourceHostname: sourceHost,
            originalUrl: job.submittedUrl,
            finalUrl: renderResult.finalUrl,
            retrievedAt: new Date(),
            contentHtml: renderResult.article.contentHtml
          },
          jobId: job.id,
          formatting: this.defaultPdfFormatting ?? { format: resolvedFormat }
        });

        if (this.vkClient) {
          await this.jobStore.updateStatus(job.id, 'uploading');
          this.logger.info(`Uploading document to VK for job ${job.id}`);

          const uploadServer = await this.vkClient.getMessagesUploadServer(job.peerId);
          const uploadedFile = await this.vkClient.uploadPdfDocument(
            uploadServer.upload_url,
            pdfResult.pdfBuffer,
            pdfResult.filename
          );

          const savedDoc = await this.vkClient.saveDocument(uploadedFile, renderResult.title);
          vkAttachment = `doc${savedDoc.doc.owner_id}_${savedDoc.doc.id}`;

          // Durable checkpoint: save attachment before sending message!
          await this.jobStore.saveAttachmentCheckpoint(job.id, vkAttachment);
        }
      } else {
        this.logger.info(`Reusing saved VK attachment ${vkAttachment} from previous attempt for job ${job.id}`);
        if (job.submittedUrl) {
          try {
            sourceHost = new URL(job.submittedUrl).hostname;
          } catch (err) { this.logger.exception(err, 'Resolve source hostname', { jobId: job.id }); }
        }
      }

      // 3. Send message with document attachment
      if (this.vkClient && vkAttachment) {
        await this.jobStore.updateStatus(job.id, 'delivering');
        this.logger.info(`Delivering message with attachment ${vkAttachment} for job ${job.id}`);

        const randomId = generateStableRandomId(`success_${job.id}`);
        const msgText = `📖 Статья готова: «${finalTitle}»\nИсточник: ${sourceHost}\nЗадание: ${job.id}`;

        await this.vkClient.sendMessage({
          peerId: job.peerId,
          message: msgText,
          attachment: vkAttachment,
          randomId
        });
      }

      // 6. Complete job
      await this.jobStore.completeJob(job.id);
      const durationSeconds = (Date.now() - startTime) / 1000;
      metrics.completedJobsTotal.inc();
      metrics.renderDurationSeconds.observe(durationSeconds);
      this.logger.info(`Job ${job.id} completed successfully in ${durationSeconds.toFixed(2)}s`);

      return { success: true, retryable: false };
    } catch (err) {
      const errorMsg = (err as Error).message || String(err);
      this.logger.exception(err, 'Process job', { jobId: job.id, attempts: job.attempts });
      const article = (err as any)?.article;
      const diagnostics = (err as any)?.diagnostics;

      // Send error details to configured ErrorListeners
      await this.notifyErrorListeners(job, errorMsg, article, diagnostics).catch((listenerErr) => {
        this.logger.exception(listenerErr, 'Failed to notify error listeners for job');
      });

      const { category, isTerminal, userMessage } = this.classifyError(errorMsg, job);

      if (isTerminal || job.attempts >= job.maxAttempts) {
        const finalCategory = isTerminal ? category : 'RETRIES_EXHAUSTED';
        const finalMessage = isTerminal ? userMessage : 'Не удалось обработать страницу после нескольких попыток.';

        metrics.failedJobsTotal.inc({ category: finalCategory });
        await this.jobStore.failJob(job.id, finalCategory, finalMessage, true);

        // Notify user about safe failure
        await this.sendFailureNotification(job, finalMessage);

        return { success: false, retryable: false }; // Terminal failure: ack message so it doesn't loop
      } else {
        metrics.retryAttemptsTotal.inc();
        await this.jobStore.failJob(job.id, category, userMessage, false);
        return { success: false, retryable: true }; // Retryable failure: YMQ will retry
      }
    } finally {
      await proxy.stop().catch(err => { this.logger.exception(err, 'Close worker resources'); });
    }
  }

  private classifyError(
    errMsg: string,
    job: Job
  ): { category: JobFailureCategory; isTerminal: boolean; userMessage: string } {
    if (
      errMsg.includes('SSRF') ||
      errMsg.includes('prohibited') ||
      errMsg.includes('Forbidden') ||
      errMsg.includes('403') ||
      errMsg.includes('blockedbyclient')
    ) {
      return {
        category: 'SSRF_BLOCKED',
        isTerminal: true,
        userMessage: 'Адрес заблокирован политикой безопасности сети (доступ к внутренним адресам запрещен).'
      };
    }

    if (errMsg.includes('CONTENT_UNSUPPORTED') || errMsg.includes('CONTENT_EMPTY')) {
      let customUserMessage = 'Не удалось извлечь текст статьи. Возможно, страница защищена авторизацией, капчей или пуста.';
      if (
        errMsg.includes('Anti-bot challenge') ||
        errMsg.includes('captcha') ||
        errMsg.includes('Cloudflare')
      ) {
        customUserMessage = 'Не удалось подготовить PDF: целевой сайт защищен проверкой на роботов (капчей или защитой от DDoS).';
      } else if (
        errMsg.includes('Authentication or paywall') ||
        errMsg.includes('login or subscription')
      ) {
        customUserMessage = 'Не удалось извлечь статью: целевой сайт требует авторизации или платной подписки.';
      } else if (errMsg.includes('HTML body is empty')) {
        customUserMessage = 'Не удалось извлечь статью: страница оказалась пустой или не смогла отобразиться в браузере.';
      }

      return {
        category: 'CONTENT_UNSUPPORTED',
        isTerminal: true,
        userMessage: customUserMessage
      };
    }

    if (errMsg.includes('exceeded limit') || errMsg.includes('SIZE_EXCEEDED')) {
      return {
        category: 'SIZE_EXCEEDED',
        isTerminal: true,
        userMessage: 'Размер страницы или итогового документа превысил допустимый лимит.'
      };
    }

    if (errMsg.includes('timed out') || errMsg.includes('TIMEOUT')) {
      return {
        category: 'TIMEOUT',
        isTerminal: false,
        userMessage: 'Превышено время ожидания ответа от целевого сайта.'
      };
    }

    if (errMsg.includes('VK API')) {
      return {
        category: 'VK_API_ERROR',
        isTerminal: false,
        userMessage: 'Временный сбой при взаимодействии с ВКонтакте.'
      };
    }

    return {
      category: 'INTERNAL_ERROR',
      isTerminal: false,
      userMessage: 'Произошла ошибка при обработке страницы.'
    };
  }

  private async sendFailureNotification(job: Job, reason: string): Promise<void> {
    if (!this.vkClient) return;

    try {
      const randomId = generateStableRandomId(`fail_${job.id}`);
      await this.vkClient.sendMessage({
        peerId: job.peerId,
        message: `❌ Не удалось подготовить PDF для задания ${job.id}:\n${reason}\n\nИзвините нас, мы уже получили уведомление об ошибке и будем исправлять, мы вам сообщим.`,
        randomId
      });
    } catch (err) {
      this.logger.exception(err, 'Failed to send failure notification for job');
    }
  }

  private async notifyErrorListeners(
    job: Job,
    errorMsg: string,
    article?: any,
    diagnostics?: any
  ): Promise<void> {
    if (!this.vkClient) return;

    let errorListeners: number[] = [];
    try {
      if (this.jobStore.getUsersByRole) {
        errorListeners = await this.jobStore.getUsersByRole(2);
      }
    } catch (err) {
      this.logger.exception(err, 'Failed to fetch error listeners (role 2) from job store');
      return;
    }

    if (!errorListeners || errorListeners.length === 0) {
      return;
    }

    const isExtractionError =
      errorMsg.includes('Could not extract meaningful readable content') ||
      article !== undefined;

    let message = `🚨 Ошибка обработки задания ${job.id}:
• Ошибка: ${errorMsg}
• URL: ${job.submittedUrl}
• Пользователь: https://vk.com/id${job.ownerId} (id${job.ownerId})`;

    if (diagnostics) {
      message += `\n\n🔍 Диагностика страницы:
• Причина: ${diagnostics.failureReason || 'Недостаточно текста'}
• Заголовок (<title>): ${diagnostics.docTitle ? JSON.stringify(diagnostics.docTitle) : '(пусто)'}
• Размер HTML: ${diagnostics.rawHtmlLength} байт
• Длина текста в body: ${diagnostics.bodyTextLength} симв.
• Итоговый URL: ${diagnostics.finalUrl || job.submittedUrl}${diagnostics.finalUrl && diagnostics.finalUrl !== job.submittedUrl ? ' ⚠️ (был редирект)' : ''}
• HTTP статус: ${diagnostics.httpStatus || 200}
• Запросов страницы: ${diagnostics.totalRequests ?? 'н/д'}`;
      if (diagnostics.semanticCandidatesFound?.length > 0) {
        message += `\n• Найденные селекторы: [${diagnostics.semanticCandidatesFound.join(', ')}]`;
      }
      if (diagnostics.bodyTextSnippet) {
        message += `\n• Фрагмент текста со страницы: "${diagnostics.bodyTextSnippet}"`;
      }
    }

    if (isExtractionError) {
      const formattedArticle = this.formatArticleForLog(article);
      message += `\n\n📄 Значение переменной "article":\n${formattedArticle}`;
    }

    if (message.length > 4000) {
      message = message.slice(0, 3950) + '\n... [текст лога обрезан из-за лимита VK]';
    }

    for (const listenerId of errorListeners) {
      try {
        const randomId = generateStableRandomId(`errlog_${job.id}_${job.attempts}_${listenerId}`);
        await this.vkClient.sendMessage({
          peerId: listenerId,
          message,
          randomId
        });
        this.logger.info(`Sent error log for job ${job.id} to error listener ${listenerId}`);
      } catch (sendErr) {
        this.logger.exception(sendErr, 'Send error listener notification');
      }
    }
  }

  private formatArticleForLog(article: any): string {
    if (article === undefined) return 'undefined';
    if (article === null) return 'null';
    try {
      const str = JSON.stringify(article, null, 2);
      if (str.length > 2500) {
        return str.slice(0, 2500) + `\n... [обрезано, полная длина: ${str.length}]`;
      }
      return str;
    } catch (err) {
      this.logger.exception(err, 'Format extraction diagnostic');
      return String(article);
    }
  }

  public async close(): Promise<void> {
    await this.browserManager.close().catch(err => { this.logger.exception(err, 'Close worker resources'); });
    await this.pdfGenerator.close().catch(err => { this.logger.exception(err, 'Close worker resources'); });
  }
}
