import { SEARCH_PAGE_SIZE } from './search-config.js';
export type ParsedCommand =
  | { type: 'read'; url: string }
  | { type: 'start' }
  | { type: 'mode'; mode: 'search' | 'ai' }
  | { type: 'new-chat' }
  | { type: 'search-read'; searchId: string; index: number }
  | { type: 'more'; searchId: string; offset: number }
  | { type: 'status'; jobId: string }
  | { type: 'version' }
  | { type: 'help' }
  | { type: 'unrecognized'; rawText: string };

export function parseCommand(text: string, payload?: string): ParsedCommand {
  if (payload) {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (data && typeof data === 'object') {
        if (data.command === 'search-read' && typeof data.searchId === 'string' && Number.isInteger(data.index) && data.index >= 0 && data.index < 20) return { type: 'search-read', searchId: data.searchId, index: data.index };
        if (data.command === 'mode' && (data.mode === 'search' || data.mode === 'ai')) return { type: 'mode', mode: data.mode };
        if (data.command === 'new-chat') return { type: 'new-chat' };
        if (data.command === 'start') return { type: 'start' };
        if (data.command === 'read' && typeof data.url === 'string') return { type: 'read', url: data.url };
        if (data.command === 'more' && typeof data.searchId === 'string' && Number.isInteger(data.offset) && data.offset > 0 && data.offset < 20 && data.offset % SEARCH_PAGE_SIZE === 0)
          return { type: 'more', searchId: data.searchId, offset: data.offset };
        if ((data.command === 'status' || data.action === 'status') && typeof data.jobId === 'string') {
          return { type: 'status', jobId: data.jobId };
        }
        if (data.command === 'version' || data.action === 'version') {
          return { type: 'version' };
        }
        if (data.command === 'help' || data.action === 'help') {
          return { type: 'help' };
        }
      }
    } catch {
      // Ignore JSON parse errors in payload and proceed to parse text
    }
  }

  const trimmed = text.trim();
  if (/^(?:✅\s*)?🔎\s*Поиск$/u.test(trimmed)) return { type: 'mode', mode: 'search' };
  if (/^(?:✅\s*)?💬\s*Чат с ИИ$/u.test(trimmed)) return { type: 'mode', mode: 'ai' };
  if (trimmed === 'Новый разговор') return { type: 'new-chat' };
  if (/^(?:\/start|начать)$/i.test(trimmed)) return { type: 'start' };

  if (/^\/help\b/i.test(trimmed) || trimmed === '?' || trimmed.toLowerCase() === 'помощь') {
    return { type: 'help' };
  }

  if (/^\/version\b/i.test(trimmed) || trimmed.toLowerCase() === 'версия' || trimmed.toLowerCase() === '/версия') {
    return { type: 'version' };
  }

  const readMatch = trimmed.match(/^\/read\s+(\S+)/i);
  if (readMatch) {
    return { type: 'read', url: readMatch[1] };
  }

  const statusMatch = trimmed.match(/^(?:\/status|(?:📊\s*)?статус)\s+(\S+)/i);
  if (statusMatch) {
    return { type: 'status', jobId: statusMatch[1] };
  }

  return { type: 'unrecognized', rawText: trimmed };
}

export function getAppVersion(): string {
  if (process.env.APP_VERSION && process.env.APP_VERSION.trim() !== '') {
    return process.env.APP_VERSION.trim();
  }
  return '1.0.0';
}

export function formatVersionMessage(): string {
  const version = getAppVersion();
  const nodeVersion = process.version;
  const env = process.env.NODE_ENV || 'development';
  return `📦 Версия сервиса Readable Web: ${version}\n⚙️ Среда: ${env} (${nodeVersion})`;
}

export const GREETING_MESSAGE = 'Привет! Я ищу веб-страницы и помогаю читать их во ВКонтакте. Напишите, что ищете, — я предложу ссылки. Выберите страницу кнопкой, и я пришлю её PDF-версию. Режимы «🔎 Поиск» и «💬 Чат с ИИ» переключаются кнопками под полем сообщения.';

export const HELP_MESSAGE = `🤖 Бот «Readable Web» (Удобное чтение)

Выберите «🔎 Поиск» или «💬 Чат с ИИ» кнопками под полем сообщения. Выбор сохраняется. В чате кнопка «Новый разговор» очищает контекст.

В режиме поиска напишите запрос — я найду ссылки через Serper. Выберите страницу кнопкой, чтобы получить PDF. «Ещё» показывает следующие результаты. Новый поиск доступен раз в 30 секунд.

Я преобразую веб-статьи и открытую документацию в чистые, удобные для чтения PDF-документы.

Команды:
• /read <URL> — создать PDF-версию статьи
  Пример: /read https://example.org/article

• /status <job-id> — узнать статус обработки вашего задания

• /version — версия сервиса

• /help — показать эту справку

ℹ️ Ограничения сервиса:
• Поддерживаются только открытые публичные HTML-статьи и документация.
• Сервис не поддерживает авторизацию, платный доступ (paywall), интерактивные приложения или закрытые сайты.
• Мы не запрашиваем и не сохраняем ваши логины и пароли.
• Изображения в MVP-версии отключены для скорости и чистоты чтения.`;

