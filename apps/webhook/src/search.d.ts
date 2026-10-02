import type { SearchResult, SearchSession } from "@readable-web/jobs";
export interface SearchClient {
    search(query: string): Promise<SearchResult[]>;
}
export declare function parseSearchResults(data: unknown): SearchResult[];
export declare class SerperClient implements SearchClient {
    private apiKey;
    private request;
    constructor(apiKey?: string, request?: typeof fetch);
    search(query: string): Promise<SearchResult[]>;
}
export { SEARCH_PAGE_SIZE } from "./search-config.js";
export declare function searchPage(session: SearchSession, offset: number): {
    message: string;
    keyboard: string;
};
//# sourceMappingURL=search.d.ts.map