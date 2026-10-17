/** Verified against https://openrouter.ai/api/v1/models on 2026-10-17. */
export declare const MODEL_OWNER_ID = 10487183;
export declare const DEFAULT_MODEL = "google/gemini-2.5-flash";
export declare const PREMIUM_MODELS: ({
    key: string;
    label: string;
    model: string;
    reasoningEffort: "low";
} | {
    key: string;
    label: string;
    model: string;
    reasoningEffort: undefined;
})[];
export declare function selectedModel(ownerId: number, key?: string): {
    key: string;
    label: string;
    model: string;
    reasoningEffort: "low";
} | {
    key: string;
    label: string;
    model: string;
    reasoningEffort: undefined;
} | undefined;
export declare function defaultModelFor(ownerId: number, configured?: string): string | undefined;
export declare function modelKeyboard(key?: string): string;
//# sourceMappingURL=models.d.ts.map