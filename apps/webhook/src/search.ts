import { SEARCH_PAGE_SIZE } from './search-config.js';
import { validateUrlSyntax } from '@readable-web/safe-network';
import { UpstreamResponseError } from '@readable-web/observability';
import type { SearchResult, SearchSession } from '@readable-web/jobs';

export interface SearchClient { search(query: string): Promise<SearchResult[]> }
export function parseSearchResults(data: unknown): SearchResult[] {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { organic?: unknown }).organic))
    throw new UpstreamResponseError('Unsupported search response', 'Serper', 200);
  const results: SearchResult[] = [];
  for (const item of (data as { organic: unknown[] }).organic) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { link?: unknown; title?: unknown; snippet?: unknown };
    if (typeof row.link !== 'string') continue;
    let url: string;
    try { url = validateUrlSyntax(row.link).normalizedUrl; } catch { continue; }
    if (results.some(r => r.url === url)) continue;
    results.push({ url, title: typeof row.title === 'string' ? row.title.trim().slice(0, 200) : url,
      snippet: typeof row.snippet === 'string' ? row.snippet.trim().replace(/\s+/g, ' ').slice(0, 350) : '' });
    if (results.length === 20) break;
  }
  return results;
}
export class SerperClient implements SearchClient {
  constructor(private apiKey = process.env.SERPER_API_KEY ?? '', private request: typeof fetch = fetch) {}
  async search(query: string): Promise<SearchResult[]> {
    if (!this.apiKey.trim()) throw new UpstreamResponseError('Search not configured', 'Serper', 503);
    const response = await this.request('https://google.serper.dev/search', {
      method: 'POST', body: JSON.stringify({ q: query, num: 20, hl: 'ru' }),
      signal: AbortSignal.timeout(8000), redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': this.apiKey }
    });
    if (!response.ok) throw new UpstreamResponseError('Search response failed', 'Serper', response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new UpstreamResponseError('Empty search response', 'Serper', response.status);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 1048576) throw new UpstreamResponseError('Search response too large', 'Serper', response.status);
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new UpstreamResponseError('Invalid search JSON', 'Serper', response.status); }
    return parseSearchResults(data);
  }
}
export { SEARCH_PAGE_SIZE } from './search-config.js';
export function searchPage(session: SearchSession, offset: number): { message: string; keyboard: string } {
  const page = session.results.slice(offset, offset + SEARCH_PAGE_SIZE);
  const message = page.map((r, i) => `${offset + i + 1}. ${r.title}\n${r.url}${r.snippet ? '\n' + r.snippet : ''}\n/read ${r.url}`).join('\n\n');
  // Short labels avoid VK's label limit; payload carries the exact /read command.
  const buttons = page.map((r, i) => [{ action: { type: 'text', label: `📄 ${offset + i + 1}. ${r.title}`.slice(0, 40),
    payload: Buffer.byteLength(JSON.stringify({ command: 'read', url: r.url }), 'utf8') <= 255
      ? JSON.stringify({ command: 'read', url: r.url })
      : JSON.stringify({ command: 'search-read', searchId: session.id, index: offset + i }) }, color: 'primary' }]);
  if (offset + SEARCH_PAGE_SIZE < session.results.length) buttons.push([{ action: { type: 'text', label: 'Ещё',
    payload: JSON.stringify({ command: 'more', searchId: session.id, offset: offset + SEARCH_PAGE_SIZE }) }, color: 'secondary' }]);
  const rows = [];
  const flatButtons = buttons.flat();
  for (let i = 0; i < flatButtons.length; i += 2) rows.push(flatButtons.slice(i, i + 2));
  return { message: message || 'Ничего не найдено. Попробуйте другой запрос.', keyboard: JSON.stringify({ inline: true, buttons: rows }) };
}
