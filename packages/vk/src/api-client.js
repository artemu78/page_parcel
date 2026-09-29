"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VkApiClient = exports.VkApiError = void 0;
const observability_1 = require("@readable-web/observability");
class VkApiError extends Error {
    errorCode;
    constructor(message, errorCode) {
        super((0, observability_1.redactSensitiveData)(message));
        this.name = 'VkApiError';
        this.errorCode = errorCode;
    }
}
exports.VkApiError = VkApiError;
class VkApiClient {
    token;
    apiVersion;
    baseUrl;
    logger;
    constructor(options) {
        this.token = options.token;
        this.apiVersion = options.apiVersion ?? '5.199';
        this.baseUrl = options.baseUrl ?? 'https://api.vk.com/method';
        this.logger = (options.logger ?? observability_1.defaultLogger).child({ component: 'VkApiClient' });
    }
    async callMethod(method, params) {
        const url = `${this.baseUrl}/${method}`;
        const bodyParams = new URLSearchParams({
            ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
            v: this.apiVersion,
            access_token: this.token
        });
        this.logger.debug(`Calling VK API method: ${method}`);
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: bodyParams.toString()
            });
        }
        catch (err) {
            throw new Error(`VK API network error on ${method}: ${(0, observability_1.redactSensitiveData)(err.message)}`);
        }
        if (!res.ok) {
            throw new Error(`VK API HTTP error on ${method}: ${res.status} ${res.statusText}`);
        }
        const data = (await res.json());
        if (data.error) {
            this.logger.error(`VK API error on ${method}: [${data.error.error_code}] ${data.error.error_msg}`);
            throw new VkApiError(data.error.error_msg, data.error.error_code);
        }
        if (data.response === undefined) {
            throw new Error(`VK API returned empty response object on ${method}`);
        }
        return data.response;
    }
    async getMessagesUploadServer(peerId) {
        return this.callMethod('docs.getMessagesUploadServer', {
            peer_id: peerId,
            type: 'doc'
        });
    }
    async uploadPdfDocument(uploadUrl, pdfBuffer, filename) {
        const targetUrl = uploadUrl.replace(/^http:\/\//i, 'https://');
        this.logger.info(`Uploading PDF document (${pdfBuffer.length} bytes, file: ${filename}) to VK upload server: ${targetUrl}`);
        const formData = new FormData();
        const blob = new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' });
        formData.append('file', blob, filename);
        let res;
        try {
            res = await fetch(targetUrl, {
                method: 'POST',
                body: formData,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                }
            });
        }
        catch (err) {
            throw new Error(`Failed to upload PDF to VK: ${(0, observability_1.redactSensitiveData)(err.message)}`);
        }
        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            this.logger.error(`VK upload server HTTP error: ${res.status} ${res.statusText} on ${targetUrl}. Response: ${errBody.slice(0, 500)}`);
            throw new Error(`VK upload server HTTP error: ${res.status} ${res.statusText} - ${errBody.slice(0, 200)}`);
        }
        const json = (await res.json());
        if (!json.file) {
            throw new Error(`VK upload server response missing file field: ${JSON.stringify(json)}`);
        }
        return json.file;
    }
    async saveDocument(file, title) {
        return this.callMethod('docs.save', {
            file,
            title
        });
    }
    async sendMessage(params) {
        const callParams = {
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
            return await this.callMethod('messages.send', callParams);
        }
        catch (err) {
            if (params.keyboard && err instanceof VkApiError && err.errorCode === 912) {
                this.logger.warn(`VK bot capabilities disabled in community settings (error 912). Falling back to sending message without keyboard.`);
                const { keyboard: _, ...fallbackParams } = callParams;
                return await this.callMethod('messages.send', fallbackParams);
            }
            throw err;
        }
    }
}
exports.VkApiClient = VkApiClient;
//# sourceMappingURL=api-client.js.map