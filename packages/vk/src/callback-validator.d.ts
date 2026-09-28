import { VkCallbackEvent, VkMessageNewEvent } from './types.js';
export interface CallbackValidationOptions {
    expectedGroupId: number;
    expectedSecret?: string;
    confirmationCode: string;
}
export type CallbackValidationResult = {
    valid: true;
    isConfirmation: true;
    response: string;
} | {
    valid: true;
    isConfirmation: false;
    event: VkCallbackEvent;
    response: 'ok';
} | {
    valid: false;
    error: string;
    statusCode: number;
};
export declare function validateCallbackPayload(body: unknown, options: CallbackValidationOptions): CallbackValidationResult;
export declare function isMessageNewEvent(event: VkCallbackEvent): event is VkMessageNewEvent;
//# sourceMappingURL=callback-validator.d.ts.map