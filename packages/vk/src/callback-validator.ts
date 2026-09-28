import { VkCallbackEvent, VkMessageNewEvent } from './types.js';

export interface CallbackValidationOptions {
  expectedGroupId: number;
  expectedSecret?: string;
  confirmationCode: string;
}

export type CallbackValidationResult =
  | { valid: true; isConfirmation: true; response: string }
  | { valid: true; isConfirmation: false; event: VkCallbackEvent; response: 'ok' }
  | { valid: false; error: string; statusCode: number };

export function validateCallbackPayload(
  body: unknown,
  options: CallbackValidationOptions
): CallbackValidationResult {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Malformed payload: body must be a JSON object', statusCode: 400 };
  }

  const payload = body as Partial<VkCallbackEvent>;

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
    event: payload as VkCallbackEvent,
    response: 'ok'
  };
}

export function isMessageNewEvent(event: VkCallbackEvent): event is VkMessageNewEvent {
  return event.type === 'message_new' && 'object' in event && 'message' in (event as VkMessageNewEvent).object;
}
