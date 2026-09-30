import { Driver, AUTO_TX, TypedValues, TypedData, TableDescription, Column, Types, StatusCode } from 'ydb-sdk';

export interface SearchResult { title: string; url: string; snippet: string }
export interface SearchSession {
  id: string; ownerId: number; peerId: number; query: string; createdAt: number;
  status: 'pending' | 'completed' | 'failed'; results: SearchResult[];
}
export interface SearchAdmission { session?: SearchSession; duplicate: boolean; retryAfterSeconds?: number }
export interface SearchStore {
  begin(session: SearchSession): Promise<SearchAdmission>;
  finish(session: SearchSession): Promise<void>;
  get(id: string): Promise<SearchSession | null>;
}
export const SEARCH_TTL_MS = 86400000;
export class MemorySearchStore implements SearchStore {
  private sessions = new Map<string, SearchSession>();
  private last = new Map<number, number>();
  async begin(session: SearchSession): Promise<SearchAdmission> {
    const now = session.createdAt;
    for (const [id, old] of this.sessions) if (old.createdAt + SEARCH_TTL_MS <= now) this.sessions.delete(id);
    const existing = this.sessions.get(session.id);
    if (existing) return { session: structuredClone(existing), duplicate: true };
    const until = (this.last.get(session.ownerId) ?? 0) + 30000;
    if (until > now) return { duplicate: false, retryAfterSeconds: Math.ceil((until - now) / 1000) };
    this.last.set(session.ownerId, now);
    this.sessions.set(session.id, structuredClone(session));
    return { session, duplicate: false };
  }
  async finish(session: SearchSession): Promise<void> { this.sessions.set(session.id, structuredClone(session)); }
  async get(id: string): Promise<SearchSession | null> {
    const s = this.sessions.get(id);
    return s && s.createdAt + SEARCH_TTL_MS > Date.now() ? structuredClone(s) : null;
  }
}

/** Query log and result cache share a row; pagination never consumes a search slot. */
export class YdbSearchStore implements SearchStore {
  constructor(private driver: Driver) {}
  async init(): Promise<void> {
    await this.driver.tableClient.withSession(async session => {
      for (const name of ['search_queries', 'search_limits']) {
        try { await session.describeTable(name); continue; } catch (error) {
          const status = error instanceof Error ? (error.constructor as { status?: number }).status : undefined;
          if (status !== StatusCode.SCHEME_ERROR && status !== StatusCode.NOT_FOUND) throw error;
        }
        const desc = name === 'search_queries'
          ? new TableDescription().withColumn(new Column('id', Types.optional(Types.UTF8)))
            .withColumn(new Column('owner_id', Types.optional(Types.INT64)))
            .withColumn(new Column('created_at', Types.optional(Types.TIMESTAMP)))
            .withColumn(new Column('data', Types.optional(Types.UTF8))).withPrimaryKey('id').withTtl('created_at', 86400)
          : new TableDescription().withColumn(new Column('owner_id', Types.optional(Types.INT64)))
            .withColumn(new Column('last_at', Types.optional(Types.INT64))).withPrimaryKey('owner_id');
        try { await session.createTable(name, desc); } catch (error) {
          const status = error instanceof Error ? (error.constructor as { status?: number }).status : undefined;
          if (status !== StatusCode.ALREADY_EXISTS && status !== StatusCode.SCHEME_ERROR) throw error;
          await session.describeTable(name);
        }
      }
    });
  }
  async begin(s: SearchSession): Promise<SearchAdmission> {
    return this.driver.tableClient.withSessionRetry(async session => {
      const res = await session.executeQuery(`
        DECLARE $id AS Utf8; DECLARE $owner AS Int64; DECLARE $now AS Int64;
        DECLARE $created AS Timestamp; DECLARE $data AS Utf8;
        $old = SELECT data FROM search_queries WHERE id = $id;
        $last = SELECT last_at FROM search_limits WHERE owner_id = $owner;
        $allowed = NOT EXISTS (SELECT * FROM $old) AND COALESCE((SELECT last_at FROM $last), 0) <= $now - 30000;
        SELECT data FROM $old;
        SELECT last_at FROM $last;
        UPSERT INTO search_queries SELECT $id AS id, $owner AS owner_id, $created AS created_at, $data AS data
          FROM AS_TABLE(AsList(AsStruct(1 AS admission_row))) WHERE $allowed;
        UPSERT INTO search_limits SELECT $owner AS owner_id, $now AS last_at
          FROM AS_TABLE(AsList(AsStruct(1 AS admission_row))) WHERE $allowed;
      `, { '$id': TypedValues.utf8(s.id), '$owner': TypedValues.int64(s.ownerId),
        '$now': TypedValues.int64(s.createdAt), '$created': TypedValues.timestamp(new Date(s.createdAt)),
        '$data': TypedValues.utf8(JSON.stringify(s)) }, AUTO_TX);
      const old = TypedData.createNativeObjects(res.resultSets[0]) as unknown as { data: string }[];
      const last = TypedData.createNativeObjects(res.resultSets[1]) as unknown as { last_at: number }[];
      if (old[0]) return { session: JSON.parse(old[0].data), duplicate: true };
      const remaining = Number(last[0]?.last_at ?? 0) + 30000 - s.createdAt;
      return remaining > 0 ? { duplicate: false, retryAfterSeconds: Math.ceil(remaining / 1000) } : { session: s, duplicate: false };
    });
  }
  async finish(s: SearchSession): Promise<void> {
    await this.driver.tableClient.withSession(session => session.executeQuery(`
      DECLARE $id AS Utf8; DECLARE $data AS Utf8;
      UPDATE search_queries SET data = $data WHERE id = $id;
    `, { '$id': TypedValues.utf8(s.id), '$data': TypedValues.utf8(JSON.stringify(s)) }, AUTO_TX));
  }
  async get(id: string): Promise<SearchSession | null> {
    return this.driver.tableClient.withSession(async session => {
      const res = await session.executeQuery('DECLARE $id AS Utf8; SELECT data FROM search_queries WHERE id = $id;',
        { '$id': TypedValues.utf8(id) }, AUTO_TX);
      const rows = TypedData.createNativeObjects(res.resultSets[0]) as unknown as { data: string }[];
      const s: SearchSession | undefined = rows[0] ? JSON.parse(rows[0].data) : undefined;
      return s && s.createdAt + SEARCH_TTL_MS > Date.now() ? s : null;
    });
  }
}
