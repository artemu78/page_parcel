"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEARCH_PAGE_SIZE = exports.SerperClient = void 0;
exports.parseSearchResults = parseSearchResults;
exports.searchPage = searchPage;
const search_config_js_1 = require("./search-config.js");
const safe_network_1 = require("@readable-web/safe-network");
const observability_1 = require("@readable-web/observability");
function parseSearchResults(data) {
    if (!data ||
        typeof data !== "object" ||
        !Array.isArray(data.organic))
        throw new observability_1.UpstreamResponseError("Unsupported search response", "Serper", 200);
    const results = [];
    for (const item of data.organic) {
        if (!item || typeof item !== "object")
            continue;
        const row = item;
        if (typeof row.link !== "string")
            continue;
        let url;
        try {
            url = (0, safe_network_1.validateUrlSyntax)(row.link).normalizedUrl;
        }
        catch {
            continue;
        }
        if (results.some((r) => r.url === url))
            continue;
        results.push({
            url,
            title: typeof row.title === "string" ? row.title.trim().slice(0, 200) : url,
            snippet: typeof row.snippet === "string"
                ? row.snippet.trim().replace(/\s+/g, " ").slice(0, 350)
                : "",
        });
        if (results.length === 20)
            break;
    }
    return results;
}
class SerperClient {
    apiKey;
    request;
    constructor(apiKey = process.env.SERPER_API_KEY ?? "", request = fetch) {
        this.apiKey = apiKey;
        this.request = request;
    }
    async search(query) {
        if (!this.apiKey.trim())
            throw new observability_1.UpstreamResponseError("Search not configured", "Serper", 503);
        const response = await this.request("https://google.serper.dev/search", {
            method: "POST",
            body: JSON.stringify({ q: query, num: 20, hl: "ru" }),
            signal: AbortSignal.timeout(8000),
            redirect: "error",
            headers: { "Content-Type": "application/json", "X-API-KEY": this.apiKey },
        });
        if (!response.ok)
            throw new observability_1.UpstreamResponseError("Search response failed", "Serper", response.status);
        const reader = response.body?.getReader();
        if (!reader)
            throw new observability_1.UpstreamResponseError("Empty search response", "Serper", response.status);
        const chunks = [];
        let size = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                size += value.length;
                if (size > 1048576)
                    throw new observability_1.UpstreamResponseError("Search response too large", "Serper", response.status);
                chunks.push(value);
            }
        }
        finally {
            await reader.cancel();
        }
        let data;
        try {
            data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        }
        catch {
            throw new observability_1.UpstreamResponseError("Invalid search JSON", "Serper", response.status);
        }
        return parseSearchResults(data);
    }
}
exports.SerperClient = SerperClient;
var search_config_js_2 = require("./search-config.js");
Object.defineProperty(exports, "SEARCH_PAGE_SIZE", { enumerable: true, get: function () { return search_config_js_2.SEARCH_PAGE_SIZE; } });
function searchPage(session, offset) {
    const page = session.results.slice(offset, offset + search_config_js_1.SEARCH_PAGE_SIZE);
    const message = page
        .map((r, i) => `${offset + i + 1}. ${r.title}\n${r.url}${r.snippet ? "\n" + r.snippet : ""}`)
        .join("\n\n");
    // Short labels avoid VK's label limit; payload carries the exact /read command.
    const buttons = page.map((r, i) => [
        {
            action: {
                type: "text",
                label: `📄 ${offset + i + 1}. ${r.title}`.slice(0, 40),
                payload: Buffer.byteLength(JSON.stringify({ command: "read", url: r.url }), "utf8") <= 255
                    ? JSON.stringify({ command: "read", url: r.url })
                    : JSON.stringify({
                        command: "search-read",
                        searchId: session.id,
                        index: offset + i,
                    }),
            },
            color: "primary",
        },
    ]);
    if (offset + search_config_js_1.SEARCH_PAGE_SIZE < session.results.length)
        buttons.push([
            {
                action: {
                    type: "text",
                    label: "Ещё",
                    payload: JSON.stringify({
                        command: "more",
                        searchId: session.id,
                        offset: offset + search_config_js_1.SEARCH_PAGE_SIZE,
                    }),
                },
                color: "secondary",
            },
        ]);
    const rows = [];
    const flatButtons = buttons.flat();
    for (let i = 0; i < flatButtons.length; i += 2)
        rows.push(flatButtons.slice(i, i + 2));
    return {
        message: `🔎 Результаты поиска\n\n${message || "Ничего не найдено. Попробуйте другой запрос."}`,
        keyboard: JSON.stringify({ inline: true, buttons: rows }),
    };
}
//# sourceMappingURL=search.js.map