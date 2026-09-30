import { Logger, defaultLogger, redactSensitiveData, UpstreamResponseError } from '@readable-web/observability';
import { VkApiResponse, VkUploadServerResponse, VkSaveDocResponse } from './types.js';

export interface VkClientOptions {
  token: string;
  apiVersion?: string;
  logger?: Logger;
  baseUrl?: string;
}

export class VkApiError extends UpstreamResponseError {
  public errorCode: number;
  constructor(message: string, errorCode: number) {
    super(redactSensitiveData(message), 'VK', 200);
    this.name = 'VkApiError';
    this.errorCode = errorCode;
  }
}

export class VkApiClient {
  private token: string;
  private apiVersion: string;
  private baseUrl: string;
  private logger: Logger;

  constructor(options: VkClientOptions) {
    this.token = options.token;
    this.apiVersion = options.apiVersion ?? '5.199';
    this.baseUrl = options.baseUrl ?? 'https://api.vk.com/method';
    this.logger = (options.logger ?? defaultLogger).child({ component: 'VkApiClient' });
  }

  private async callMethod<T>(method: string, params: Record<string, string | number>): Promise<T> {
    const url = `${this.baseUrl}/${method}`;
    const bodyParams = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      v: this.apiVersion,
      access_token: this.token
    });

    this.logger.debug(`Calling VK API method: ${method}`);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: bodyParams.toString()
      });
    } catch (err) {
      throw new Error(`VK API network error on ${method}: ${redactSensitiveData((err as Error).message)}`);
    }

    this.logger.info('VK HTTP response', { httpStatus: res.status });
    if (!res.ok) {
      throw new UpstreamResponseError(`VK API HTTP error on ${method}: ${res.status}`, 'VK', res.status);
    }

    let data: VkApiResponse<T>;
    try { data = await res.json() as VkApiResponse<T>; } catch {
      throw new UpstreamResponseError('VK API returned invalid JSON', 'VK', res.status);
    }

    if (data?.error) {
      this.logger.info('VK API response error', { method, apiCode: data.error.error_code });
      throw new VkApiError(data.error.error_msg, data.error.error_code);
    }

    if (data?.response === undefined) {
      throw new UpstreamResponseError(`VK API returned empty response object on ${method}`, 'VK', res.status);
    }

    return data.response;
  }

  public async getMessagesUploadServer(peerId: number): Promise<VkUploadServerResponse> {
    return this.callMethod<VkUploadServerResponse>('docs.getMessagesUploadServer', {
      peer_id: peerId,
      type: 'doc'
    });
  }

  public async uploadPdfDocument(uploadUrl: string, pdfBuffer: Buffer, filename: string): Promise<string> {
    const targetUrl = uploadUrl.replace(/^http:\/\//i, 'https://');
    this.logger.info(`Uploading PDF document (${pdfBuffer.length} bytes, file: ${filename}) to VK upload server: ${targetUrl}`);

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' });
    formData.append('file', blob, filename);

    let res: Response;
    try {
      res = await fetch(targetUrl, {
        method: 'POST',
        body: formData,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
      });
    } catch (err) {
      throw new Error(`Failed to upload PDF to VK: ${redactSensitiveData((err as Error).message)}`);
    }

    this.logger.info('VK HTTP response', { httpStatus: res.status });
    if (!res.ok) {
      await res.body?.cancel();
      throw new UpstreamResponseError(`VK upload server HTTP error: ${res.status}`, 'VK upload', res.status);
    }

    let json: { file?: string; error?: string };
    try { json = await res.json() as typeof json; } catch {
      throw new UpstreamResponseError('VK upload server returned invalid JSON', 'VK upload', res.status);
    }
    if (!json?.file) {
      throw new UpstreamResponseError('VK upload server response missing file field', 'VK upload', res.status);
    }

    return json.file;
  }

  public async saveDocument(file: string, title: string): Promise<VkSaveDocResponse> {
    return this.callMethod<VkSaveDocResponse>('docs.save', {
      file,
      title
    });
  }

  public async sendMessage(params: {
    peerId: number;
    message: string;
    attachment?: string;
    randomId: number;
    keyboard?: string;
  }): Promise<number> {
    const callParams: Record<string, string | number> = {
      peer_id: params.peerId,
      message: params.message,
      random_id: params.randomId
    };

    if (params.attachment) {
      callParams.attachment = params.attachment;
    }

    if (params.keyboard) {
      callParams.keyboard = params.keyboard;
    }

    try {
      return await this.callMethod<number>('messages.send', callParams);
    } catch (err) {
      if (params.keyboard && err instanceof VkApiError && err.errorCode === 912) {
        this.logger.info(
          `VK bot capabilities disabled in community settings (error 912). Falling back to sending message without keyboard.`
        );
        const { keyboard: _, ...fallbackParams } = callParams;
        return await this.callMethod<number>('messages.send', fallbackParams);
      }
      throw err;
    }
  }
}
