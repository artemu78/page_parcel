import { Logger } from '@readable-web/observability';
import { VkUploadServerResponse, VkSaveDocResponse } from './types.js';
export interface VkClientOptions {
    token: string;
    apiVersion?: string;
    logger?: Logger;
    baseUrl?: string;
}
export declare class VkApiError extends Error {
    errorCode: number;
    constructor(message: string, errorCode: number);
}
export declare class VkApiClient {
    private token;
    private apiVersion;
    private baseUrl;
    private logger;
    constructor(options: VkClientOptions);
    private callMethod;
    getMessagesUploadServer(peerId: number): Promise<VkUploadServerResponse>;
    uploadPdfDocument(uploadUrl: string, pdfBuffer: Buffer, filename: string): Promise<string>;
    saveDocument(file: string, title: string): Promise<VkSaveDocResponse>;
    sendMessage(params: {
        peerId: number;
        message: string;
        attachment?: string;
        randomId: number;
    }): Promise<number>;
}
//# sourceMappingURL=api-client.d.ts.map