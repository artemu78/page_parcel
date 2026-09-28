import { JobStore, Job, JobFailureCategory } from '@readable-web/jobs';
import { ValidatingEgressProxy } from '@readable-web/safe-network';
import { BrowserManager } from '@readable-web/rendering';
import { PdfGenerator } from '@readable-web/pdf';
import { VkApiClient, generateStableRandomId } from '@readable-web/vk';
import { Logger, defaultLogger, metrics } from '@readable-web/observability';

export interface JobProcessorOptions {
  jobStore: JobStore;
  vkClient?: VkApiClient;
  workerId?: string;
  logger?: Logger;
  leaseDurationMs?: number;
}

export class JobProcessor {
  private jobStore: JobStore;
  private vkClient?: VkApiClient;
  private workerId: string;
  private logger: Logger;
  private leaseDurationMs: number;
  private browserManager: BrowserManager;
  private pdfGenerator: PdfGenerator;

  constructor(options: JobProcessorOptions) {
    this.jobStore = options.jobStore;
    this.vkClient = options.vkClient;
    this.workerId = options.workerId ?? `worker_${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
    this.logger = (options.logger ?? defaultLogger).child({ component: 'JobProcessor', workerId: this.workerId });
    this.leaseDurationMs = options.leaseDurationMs ?? 90000; // 90 seconds
    this.browserManager = new BrowserManager(this.logger);
    this.pdfGenerator = new PdfGenerator(this.logger);
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

    // Start local validating egress proxy for this job
    const proxy = new ValidatingEgressProxy({ logger: this.logger });
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
          timeoutMs: 45000
        });

        finalTitle = renderResult.title;
        sourceHost = new URL(renderResult.finalUrl).hostname;

        // Update state with final URL and title
        await this.jobStore.updateStatus(job.id, 'rendering', {
          expectedVersion: job.version,
          finalUrl: renderResult.finalUrl,
          title: renderResult.title
        });

        // Generate clean reader PDF
        this.logger.info(`Generating PDF for job ${job.id}`);
        const pdfResult = await this.pdfGenerator.generate({
          data: {
            title: renderResult.title,
            sourceHostname: sourceHost,
            originalUrl: job.submittedUrl,
            finalUrl: renderResult.finalUrl,
            retrievedAt: new Date(),
            contentHtml: renderResult.article.contentHtml
          },
          jobId: job.id
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
          } catch {}
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
      this.logger.error(`Error processing job ${job.id}: ${errorMsg}`);

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
      await proxy.stop().catch(() => {});
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
      return {
        category: 'CONTENT_UNSUPPORTED',
        isTerminal: true,
        userMessage: 'Не удалось извлечь текст статьи. Возможно, страница защищена авторизацией, капчей или пуста.'
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
        message: `❌ Не удалось подготовить PDF для задания ${job.id}:\n${reason}`,
        randomId
      });
    } catch (err) {
      this.logger.warn(`Failed to send failure notification for job ${job.id}: ${(err as Error).message}`);
    }
  }

  public async close(): Promise<void> {
    await this.browserManager.close().catch(() => {});
    await this.pdfGenerator.close().catch(() => {});
  }
}
