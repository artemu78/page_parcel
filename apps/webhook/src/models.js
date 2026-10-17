"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PREMIUM_MODELS = exports.DEFAULT_MODEL = exports.MODEL_OWNER_ID = void 0;
exports.selectedModel = selectedModel;
exports.defaultModelFor = defaultModelFor;
exports.modelKeyboard = modelKeyboard;
/** Verified against https://openrouter.ai/api/v1/models on 2026-10-17. */
exports.MODEL_OWNER_ID = 10487183;
exports.DEFAULT_MODEL = 'google/gemini-2.5-flash';
exports.PREMIUM_MODELS = [
    { key: 'sol-low', label: 'GPT Sol 6.1 · low', model: 'openai/gpt-6.1-sol', reasoningEffort: 'low' },
    { key: 'astra', label: 'GPT-6 Astra', model: 'openai/gpt-6-astra', reasoningEffort: undefined }
];
function selectedModel(ownerId, key) {
    return ownerId === exports.MODEL_OWNER_ID ? exports.PREMIUM_MODELS.find(model => model.key === key) : undefined;
}
function defaultModelFor(ownerId, configured) {
    // Also protect against a premium model accidentally becoming the global default.
    const restricted = configured && /^openai\/gpt-(?:6\.1-sol|6-astra)(?:$|[-:])/.test(configured);
    return ownerId !== exports.MODEL_OWNER_ID && restricted ? exports.DEFAULT_MODEL : configured;
}
function modelKeyboard(key) {
    return JSON.stringify({ inline: true, buttons: [
            { key: 'default', label: 'По умолчанию' }, ...exports.PREMIUM_MODELS
        ].map(option => [{ action: { type: 'text',
                    label: `${(key || 'default') === option.key ? '✅ ' : ''}${option.label}`,
                    payload: JSON.stringify({ command: 'model', model: option.key }) },
                color: (key || 'default') === option.key ? 'primary' : 'secondary' }]) });
}
//# sourceMappingURL=models.js.map