export interface VkCallbackBaseEvent {
  type: string;
  group_id: number;
  secret?: string;
  event_id?: string;
}

export interface VkConfirmationEvent extends VkCallbackBaseEvent {
  type: 'confirmation';
}

export interface VkMessageObject {
  id: number;
  date: number;
  peer_id: number;
  from_id: number;
  text: string;
  random_id?: number;
  conversation_message_id?: number;
  payload?: string;
}

export interface VkMessageNewObject {
  message: VkMessageObject;
  client_info?: {
    button_actions?: string[];
    keyboard?: boolean;
    inline_keyboard?: boolean;
    carousel?: boolean;
    lang_id?: number;
  };
}

export interface VkMessageNewEvent extends VkCallbackBaseEvent {
  type: 'message_new';
  object: VkMessageNewObject;
}

export type VkCallbackEvent = VkConfirmationEvent | VkMessageNewEvent | VkCallbackBaseEvent;

export interface VkApiResponse<T> {
  response?: T;
  error?: {
    error_code: number;
    error_msg: string;
    request_params?: Array<{ key: string; value: string }>;
  };
}

export interface VkUploadServerResponse {
  upload_url: string;
}

export interface VkSaveDocResponse {
  type: string;
  doc: {
    id: number;
    owner_id: number;
    title: string;
    size: number;
    ext: string;
    url: string;
    date: number;
  };
}

export type VkButtonColor = 'primary' | 'secondary' | 'positive' | 'negative';

export interface VkKeyboardButtonAction {
  type: string;
  label?: string;
  payload?: string;
  link?: string;
  app_id?: number;
  owner_id?: number;
  hash?: string;
  [key: string]: unknown;
}

export interface VkKeyboardButton {
  action: VkKeyboardButtonAction;
  color?: VkButtonColor;
}

export interface VkKeyboard {
  one_time?: boolean;
  inline?: boolean;
  buttons: VkKeyboardButton[][];
}

