"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.YdbSearchStore = exports.MemorySearchStore = exports.SEARCH_TTL_MS = void 0;
const ydb_sdk_1 = require("ydb-sdk");
exports.SEARCH_TTL_MS = 86400000;
class MemorySearchStore {
    sessions = new Map();
    last = new Map();
    async begin(session) {
        const now = session.createdAt;
        for (const [id, old] of this.sessions)
            if (old.createdAt + exports.SEARCH_TTL_MS <= now)
                this.sessions.delete(id);
        const existing = this.sessions.get(session.id);
        if (existing)
            return { session: structuredClone(existing), duplicate: true };
        const until = (this.last.get(session.ownerId) ?? 0) + 30000;
        if (until > now)
            return { duplicate: false, retryAfterSeconds: Math.ceil((until - now) / 1000) };
        this.last.set(session.ownerId, now);
        this.sessions.set(session.id, structuredClone(session));
        return { session, duplicate: false };
    }
    async finish(session) { this.sessions.set(session.id, structuredClone(session)); }
    async get(id) {
        const s = this.sessions.get(id);
        return s && s.createdAt + exports.SEARCH_TTL_MS > Date.now() ? structuredClone(s) : null;
    }
}
exports.MemorySearchStore = MemorySearchStore;
/** Query log and result cache share a row; pagination never consumes a search slot. */
class YdbSearchStore {
    driver;
    constructor(driver) {
        this.driver = driver;
    }
    async init() {
        await this.driver.tableClient.withSession(async (session) => {
            for (const name of ['search_queries', 'search_limits']) {
                try {
                    await session.describeTable(name);
                    continue;
                }
                catch (error) {
                    const status = error instanceof Error ? error.constructor.status : undefined;
                    if (status !== ydb_sdk_1.StatusCode.SCHEME_ERROR && status !== ydb_sdk_1.StatusCode.NOT_FOUND)
                        throw error;
                }
                const desc = name === 'search_queries'
                    ? new ydb_sdk_1.TableDescription().withColumn(new ydb_sdk_1.Column('id', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.UTF8)))
                        .withColumn(new ydb_sdk_1.Column('owner_id', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.INT64)))
                        .withColumn(new ydb_sdk_1.Column('created_at', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.TIMESTAMP)))
                        .withColumn(new ydb_sdk_1.Column('data', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.UTF8))).withPrimaryKey('id').withTtl('created_at', 86400)
                    : new ydb_sdk_1.TableDescription().withColumn(new ydb_sdk_1.Column('owner_id', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.INT64)))
                        .withColumn(new ydb_sdk_1.Column('last_at', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.INT64))).withPrimaryKey('owner_id');
                try {
                    await session.createTable(name, desc);
                }
                catch (error) {
                    const status = error instanceof Error ? error.constructor.status : undefined;
                    if (status !== ydb_sdk_1.StatusCode.ALREADY_EXISTS && status !== ydb_sdk_1.StatusCode.SCHEME_ERROR)
                        throw error;
                    await session.describeTable(name);
                }
            }
        });
    }
    async begin(s) {
        return this.driver.tableClient.withSessionRetry(async (session) => {
            const res = await session.executeQuery(`
        DECLARE $id AS Utf8; DECLARE $owner AS Int64; DECLARE $now AS Int64;
        DECLARE $created AS Timestamp; DECLARE $data AS Utf8;
        $old = SELECT data FROM search_queries WHERE id = $id;
        $last = SELECT last_at FROM search_limits WHERE owner_id = $owner;
        $allowed = NOT EXISTS (SELECT * FROM $old) AND COALESCE((SELECT last_at FROM $last), 0) <= $now - 30000;
        SELECT data FROM $old;
        SELECT last_at FROM $last;
        UPSERT INTO search_queries SELECT $id AS id, $owner AS owner_id, $created AS created_at, $data AS data WHERE $allowed;
        UPSERT INTO search_limits SELECT $owner AS owner_id, $now AS last_at WHERE $allowed;
      `, { '$id': ydb_sdk_1.TypedValues.utf8(s.id), '$owner': ydb_sdk_1.TypedValues.int64(s.ownerId),
                '$now': ydb_sdk_1.TypedValues.int64(s.createdAt), '$created': ydb_sdk_1.TypedValues.timestamp(new Date(s.createdAt)),
                '$data': ydb_sdk_1.TypedValues.utf8(JSON.stringify(s)) }, ydb_sdk_1.AUTO_TX);
            const old = ydb_sdk_1.TypedData.createNativeObjects(res.resultSets[0]);
            const last = ydb_sdk_1.TypedData.createNativeObjects(res.resultSets[1]);
            if (old[0])
                return { session: JSON.parse(old[0].data), duplicate: true };
            const remaining = Number(last[0]?.last_at ?? 0) + 30000 - s.createdAt;
            return remaining > 0 ? { duplicate: false, retryAfterSeconds: Math.ceil(remaining / 1000) } : { session: s, duplicate: false };
        });
    }
    async finish(s) {
        await this.driver.tableClient.withSession(session => session.executeQuery(`
      DECLARE $id AS Utf8; DECLARE $data AS Utf8;
      UPDATE search_queries SET data = $data WHERE id = $id;
    `, { '$id': ydb_sdk_1.TypedValues.utf8(s.id), '$data': ydb_sdk_1.TypedValues.utf8(JSON.stringify(s)) }, ydb_sdk_1.AUTO_TX));
    }
    async get(id) {
        return this.driver.tableClient.withSession(async (session) => {
            const res = await session.executeQuery('DECLARE $id AS Utf8; SELECT data FROM search_queries WHERE id = $id;', { '$id': ydb_sdk_1.TypedValues.utf8(id) }, ydb_sdk_1.AUTO_TX);
            const rows = ydb_sdk_1.TypedData.createNativeObjects(res.resultSets[0]);
            const s = rows[0] ? JSON.parse(rows[0].data) : undefined;
            return s && s.createdAt + exports.SEARCH_TTL_MS > Date.now() ? s : null;
        });
    }
}
exports.YdbSearchStore = YdbSearchStore;
//# sourceMappingURL=search-store.js.map