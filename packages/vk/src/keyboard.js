"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStatusKeyboard = createStatusKeyboard;
/**
 * Creates an inline keyboard containing a button to check job status.
 *
 * @param jobId - Identifier of the job to check status for
 * @returns JSON string representing the VK inline keyboard
 */
function createStatusKeyboard(jobId) {
    const keyboard = {
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
//# sourceMappingURL=keyboard.js.map