/**
 * Creates an inline keyboard containing a button to check job status.
 *
 * @param jobId - Identifier of the job to check status for
 * @returns JSON string representing the VK inline keyboard
 */
export declare function createStatusKeyboard(jobId: string): string;
/** Persistent mode controls stay separate from inline result actions. */
export declare function createModeKeyboard(mode: 'search' | 'ai'): string;
//# sourceMappingURL=keyboard.d.ts.map