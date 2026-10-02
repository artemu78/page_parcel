import { VkKeyboard } from './types.js';

/**
 * Creates an inline keyboard containing a button to check job status.
 *
 * @param jobId - Identifier of the job to check status for
 * @returns JSON string representing the VK inline keyboard
 */
export function createStatusKeyboard(jobId: string): string {
  const keyboard: VkKeyboard = {
    inline: true,
    buttons: [
      [
        {
          action: {
            type: 'text',
            label: '📊 Проверить статус',
            payload: JSON.stringify({ command: 'status', jobId })
          },
          color: 'primary'
        }
      ]
    ]
  };

  return JSON.stringify(keyboard);
}

/** Persistent mode controls stay separate from inline result actions. */
export function createModeKeyboard(mode: 'search' | 'ai'): string {
  const button = (target: 'search' | 'ai', label: string) => ({
    action: { type: 'text', label: `${mode === target ? '✅ ' : ''}${label}`,
      payload: JSON.stringify({ command: 'mode', mode: target }) },
    color: mode === target ? 'primary' : 'secondary'
  });
  return JSON.stringify({ inline: false, one_time: false, buttons: [
    [button('search', '🔎 Поиск'), button('ai', '💬 Чат с ИИ')],
    ...(mode === 'ai' ? [[{ action: { type: 'text', label: 'Новый разговор',
      payload: JSON.stringify({ command: 'new-chat' }) }, color: 'secondary' }]] : [])
  ] });
}
