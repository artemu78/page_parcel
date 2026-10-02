import { Driver } from 'ydb-sdk';
export type ChatMode = 'search' | 'ai';
export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}
export interface Conversation {
    version: number;
    mode: ChatMode;
    history: ChatMessage[];
    historyUpdatedAt: number;
    recentEvents: string[];
    pending?: {
        eventId: string;
        expiresAt: number;
    };
}
export declare const HISTORY_TTL_MS = 86400000;
export declare function emptyConversation(): Conversation;
export declare function trimHistory(history: ChatMessage[]): ChatMessage[];
export interface ConversationStore {
    get(ownerId: number): Promise<Conversation>;
    compareAndSet(ownerId: number, expectedVersion: number, next: Conversation): Promise<boolean>;
}
export declare class MemoryConversationStore implements ConversationStore {
    private rows;
    get(ownerId: number): Promise<Conversation>;
    compareAndSet(ownerId: number, expectedVersion: number, next: Conversation): Promise<boolean>;
}
/** Mode has no TTL; history is separately expired on access before it is used. */
export declare class YdbConversationStore implements ConversationStore {
    private driver;
    constructor(driver: Driver);
    init(): Promise<void>;
    get(ownerId: number): Promise<Conversation>;
    compareAndSet(ownerId: number, expectedVersion: number, next: Conversation): Promise<boolean>;
}
//# sourceMappingURL=conversation-store.d.ts.map