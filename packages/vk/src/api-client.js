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
        this.logger.debug(`Uploading PDF document (${pdfBuffer.length} bytes) to VK upload server`);
        const formData = new FormData();
        const blob = new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' });
        formData.append('file', blob, filename);
        let res;
        try {
            res = await fetch(uploadUrl, {
                method: 'POST',
                body: formData
            });
        }
        catch (err) {
            throw new Error(`Failed to upload PDF to VK: ${(0, observability_1.redactSensitiveData)(err.message)}`);
        }
        if (!res.ok) {
            throw new Error(`VK upload server HTTP error: ${res.status} ${res.statusText}`);
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
        return this.callMethod('messages.send', callParams);
    }
}
exports.VkApiClient = VkApiClient;
//# sourceMappingURL=api-client.js.map