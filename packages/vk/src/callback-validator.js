"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateCallbackPayload = validateCallbackPayload;
exports.isMessageNewEvent = isMessageNewEvent;
function validateCallbackPayload(body, options) {
    if (!body || typeof body !== 'object') {
        return { valid: false, error: 'Malformed payload: body must be a JSON object', statusCode: 400 };
    }
    const payload = body;
    if (typeof payload.type !== 'string' || !payload.type) {
        return { valid: false, error: 'Missing or invalid "type" field', statusCode: 400 };
    }
    if (typeof payload.group_id !== 'number' || payload.group_id !== options.expectedGroupId) {
        return {
            valid: false,
            error: `Group ID mismatch: expected ${options.expectedGroupId}, received ${payload.group_id}`,
            statusCode: 403
        };
    }
    if (options.expectedSecret) {
        if (payload.secret !== options.expectedSecret) {
            return { valid: false, error: 'Invalid or missing Callback API secret', statusCode: 403 };
        }
    }
    if (payload.type === 'confirmation') {
        return {
            valid: true,
            isConfirmation: true,
            response: options.confirmationCode
        };
    }
    return {
        valid: true,
        isConfirmation: false,
        event: payload,
        response: 'ok'
    };
}
function isMessageNewEvent(event) {
    return event.type === 'message_new' && 'object' in event && 'message' in event.object;
}
//# sourceMappingURL=callback-validator.js.map