/** Verified against https://openrouter.ai/api/v1/models on 2026-10-17. */
export const MODEL_OWNER_ID = 10487183;
export const DEFAULT_MODEL = 'google/gemini-2.5-flash';
export const PREMIUM_MODELS = [
  { key: 'sol-low', label: 'GPT Sol 6.1 · low', model: 'openai/gpt-6.1-sol', reasoningEffort: 'low' as const },
  { key: 'astra', label: 'GPT-6 Astra', model: 'openai/gpt-6-astra', reasoningEffort: undefined }
];
export function selectedModel(ownerId: number, key?: string) {
  return ownerId === MODEL_OWNER_ID ? PREMIUM_MODELS.find(model => model.key === key) : undefined;
}
export function defaultModelFor(ownerId: number, configured?: string): string | undefined {
  // Also protect against a premium model accidentally becoming the global default.
  const restricted = configured && /^openai\/gpt-(?:6\.1-sol|6-astra)(?:$|[-:])/.test(configured);
  return ownerId !== MODEL_OWNER_ID && restricted ? DEFAULT_MODEL : configured;
}
export function modelKeyboard(key?: string): string {
  return JSON.stringify({ inline: true, buttons: [
    { key: 'default', label: 'По умолчанию' }, ...PREMIUM_MODELS
  ].map(option => [{ action: { type: 'text',
    label: `${(key || 'default') === option.key ? '✅ ' : ''}${option.label}`,
    payload: JSON.stringify({ command: 'model', model: option.key }) },
    color: (key || 'default') === option.key ? 'primary' : 'secondary' }]) });
}
