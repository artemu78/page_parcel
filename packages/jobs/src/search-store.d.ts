import { Driver } from 'ydb-sdk';
export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}
export interface SearchSession {
    id: string;
    ownerId: number;
    peerId: number;
    query: string;
    createdAt: number;
    status: 'pending' | 'completed' | 'failed';
    results: SearchResult[];
}
export interface SearchAdmission {
    session?: SearchSession;
    duplicate: boolean;
    retryAfterSeconds?: number;
}
export interface SearchStore {
    begin(session: SearchSession): Promise<SearchAdmission>;
    finish(session: SearchSession): Promise<void>;
    get(id: string): Promise<SearchSession | null>;
}
export declare const SEARCH_TTL_MS = 86400000;
export declare class MemorySearchStore implements SearchStore {
    private sessions;
    private last;
    begin(session: SearchSession): Promise<SearchAdmission>;
    finish(session: SearchSession): Promise<void>;
    get(id: string): Promise<SearchSession | null>;
}
/** Query log and result cache share a row; pagination never consumes a search slot. */
export declare class YdbSearchStore implements SearchStore {
    private driver;
    constructor(driver: Driver);
    init(): Promise<void>;
    begin(s: SearchSession): Promise<SearchAdmission>;
    finish(s: SearchSession): Promise<void>;
    get(id: string): Promise<SearchSession | null>;
}
//# sourceMappingURL=search-store.d.ts.map