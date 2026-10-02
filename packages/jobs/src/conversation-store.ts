import { Driver, AUTO_TX, TypedValues, TypedData, TableDescription, Column, Types, StatusCode } from 'ydb-sdk';

export type ChatMode = 'search' | 'ai';
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface Conversation {
  version: number;
  mode: ChatMode;
  history: ChatMessage[];
  historyUpdatedAt: number;
  recentEvents: string[];
  pending?: { eventId: string; expiresAt: number };
}
export const HISTORY_TTL_MS = 86400000;
export function emptyConversation(): Conversation {
  return { version: 0, mode: 'search', history: [], historyUpdatedAt: 0, recentEvents: [] };
}
export function trimHistory(history: ChatMessage[]): ChatMessage[] {
  const kept = history.slice(-24);
  while (kept.length && kept.reduce((n, m) => n + m.content.length, 0) > 24000) kept.splice(0, 2);
  return kept;
}
export interface ConversationStore {
  get(ownerId: number): Promise<Conversation>;
  compareAndSet(ownerId: number, expectedVersion: number, next: Conversation): Promise<boolean>;
}
export class MemoryConversationStore implements ConversationStore {
  private rows = new Map<number, Conversation>();
  async get(ownerId: number): Promise<Conversation> {
    return structuredClone(this.rows.get(ownerId) ?? emptyConversation());
  }
  async compareAndSet(ownerId: number, expectedVersion: number, next: Conversation): Promise<boolean> {
    if ((this.rows.get(ownerId)?.version ?? 0) !== expectedVersion) return false;
    this.rows.set(ownerId, structuredClone({ ...next, version: expectedVersion + 1 }));
    return true;
  }
}
/** Mode has no TTL; history is separately expired on access before it is used. */
export class YdbConversationStore implements ConversationStore {
  constructor(private driver: Driver) {}
  async init(): Promise<void> {
    await this.driver.tableClient.withSession(async session => {
      try { await session.describeTable('conversations'); return; } catch (error) {
        const status = error instanceof Error ? (error.constructor as { status?: number }).status : undefined;
        if (status !== StatusCode.SCHEME_ERROR && status !== StatusCode.NOT_FOUND) throw error;
      }
      const desc = new TableDescription()
        .withColumn(new Column('owner_id', Types.optional(Types.INT64)))
        .withColumn(new Column('version', Types.optional(Types.INT64)))
        .withColumn(new Column('data', Types.optional(Types.UTF8)))
        .withPrimaryKey('owner_id');
      try { await session.createTable('conversations', desc); } catch (error) {
        const status = error instanceof Error ? (error.constructor as { status?: number }).status : undefined;
        if (status !== StatusCode.ALREADY_EXISTS && status !== StatusCode.SCHEME_ERROR) throw error;
        await session.describeTable('conversations');
      }
    });
  }
  async get(ownerId: number): Promise<Conversation> {
    return this.driver.tableClient.withSessionRetry(async session => {
      const res = await session.executeQuery('DECLARE $owner AS Int64; SELECT data FROM conversations WHERE owner_id = $owner;',
        { '$owner': TypedValues.int64(ownerId) }, AUTO_TX);
      const rows = TypedData.createNativeObjects(res.resultSets[0]) as unknown as { data: string }[];
      return rows[0] ? JSON.parse(rows[0].data) : emptyConversation();
    });
  }
  async compareAndSet(ownerId: number, expectedVersion: number, next: Conversation): Promise<boolean> {
    return this.driver.tableClient.withSessionRetry(async session => {
      const res = await session.executeQuery(`
        DECLARE $owner AS Int64; DECLARE $expected AS Int64; DECLARE $data AS Utf8;
        $old = SELECT version FROM conversations WHERE owner_id = $owner;
        SELECT version FROM $old;
        UPSERT INTO conversations SELECT $owner AS owner_id, $expected + 1 AS version, $data AS data
          FROM AS_TABLE(AsList(AsStruct(1 AS cas_row)))
          WHERE COALESCE((SELECT version FROM $old), 0) = $expected;
      `, { '$owner': TypedValues.int64(ownerId), '$expected': TypedValues.int64(expectedVersion),
        '$data': TypedValues.utf8(JSON.stringify({ ...next, version: expectedVersion + 1 })) }, AUTO_TX);
      const old = TypedData.createNativeObjects(res.resultSets[0]) as unknown as { version: number }[];
      return Number(old[0]?.version ?? 0) === expectedVersion;
    });
  }
}
