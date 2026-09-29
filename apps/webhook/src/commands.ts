export type ParsedCommand =
  | { type: 'read'; url: string }
  | { type: 'status'; jobId: string }
  | { type: 'version' }
  | { type: 'help' }
  | { type: 'unrecognized'; rawText: string };

export function parseCommand(text: string, payload?: string): ParsedCommand {
  if (payload) {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (data && typeof data === 'object') {
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

export const HELP_MESSAGE = `🤖 Бот «Readable Web» (Удобное чтение)

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

