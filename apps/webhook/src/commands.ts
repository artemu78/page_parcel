export type ParsedCommand =
  | { type: 'read'; url: string }
  | { type: 'status'; jobId: string }
  | { type: 'help' }
  | { type: 'unrecognized'; rawText: string };

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();

  if (/^\/help\b/i.test(trimmed) || trimmed === '?' || trimmed.toLowerCase() === 'помощь') {
    return { type: 'help' };
  }

  const readMatch = trimmed.match(/^\/read\s+(\S+)/i);
  if (readMatch) {
    return { type: 'read', url: readMatch[1] };
  }

  const statusMatch = trimmed.match(/^\/status\s+(\S+)/i);
  if (statusMatch) {
    return { type: 'status', jobId: statusMatch[1] };
  }

  return { type: 'unrecognized', rawText: trimmed };
}

export const HELP_MESSAGE = `🤖 Бот «Readable Web» (Удобное чтение)

Я преобразую веб-статьи и открытую документацию в чистые, удобные для чтения PDF-документы.

Команды:
• /read <URL> — создать PDF-версию статьи
  Пример: /read https://example.org/article

• /status <job-id> — узнать статус обработки вашего задания

• /help — показать эту справку

ℹ️ Ограничения сервиса:
• Поддерживаются только открытые публичные HTML-статьи и документация.
• Сервис не поддерживает авторизацию, платный доступ (paywall), интерактивные приложения или закрытые сайты.
• Мы не запрашиваем и не сохраняем ваши логины и пароли.
• Изображения в MVP-версии отключены для скорости и чистоты чтения.`;
