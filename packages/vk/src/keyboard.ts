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
