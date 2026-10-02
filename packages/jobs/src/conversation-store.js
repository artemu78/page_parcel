"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.YdbConversationStore = exports.MemoryConversationStore = exports.HISTORY_TTL_MS = void 0;
exports.emptyConversation = emptyConversation;
exports.trimHistory = trimHistory;
const ydb_sdk_1 = require("ydb-sdk");
exports.HISTORY_TTL_MS = 86400000;
function emptyConversation() {
    return { version: 0, mode: 'search', history: [], historyUpdatedAt: 0, recentEvents: [] };
}
function trimHistory(history) {
    const kept = history.slice(-24);
    while (kept.length && kept.reduce((n, m) => n + m.content.length, 0) > 24000)
        kept.splice(0, 2);
    return kept;
}
class MemoryConversationStore {
    rows = new Map();
    async get(ownerId) {
        return structuredClone(this.rows.get(ownerId) ?? emptyConversation());
    }
    async compareAndSet(ownerId, expectedVersion, next) {
        if ((this.rows.get(ownerId)?.version ?? 0) !== expectedVersion)
            return false;
        this.rows.set(ownerId, structuredClone({ ...next, version: expectedVersion + 1 }));
        return true;
    }
}
exports.MemoryConversationStore = MemoryConversationStore;
/** Mode has no TTL; history is separately expired on access before it is used. */
class YdbConversationStore {
    driver;
    constructor(driver) {
        this.driver = driver;
    }
    async init() {
        await this.driver.tableClient.withSession(async (session) => {
            try {
                await session.describeTable('conversations');
                return;
            }
            catch (error) {
                const status = error instanceof Error ? error.constructor.status : undefined;
                if (status !== ydb_sdk_1.StatusCode.SCHEME_ERROR && status !== ydb_sdk_1.StatusCode.NOT_FOUND)
                    throw error;
            }
            const desc = new ydb_sdk_1.TableDescription()
                .withColumn(new ydb_sdk_1.Column('owner_id', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.INT64)))
                .withColumn(new ydb_sdk_1.Column('version', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.INT64)))
                .withColumn(new ydb_sdk_1.Column('data', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.UTF8)))
                .withPrimaryKey('owner_id');
            try {
                await session.createTable('conversations', desc);
            }
            catch (error) {
                const status = error instanceof Error ? error.constructor.status : undefined;
                if (status !== ydb_sdk_1.StatusCode.ALREADY_EXISTS && status !== ydb_sdk_1.StatusCode.SCHEME_ERROR)
                    throw error;
                await session.describeTable('conversations');
            }
        });
    }
    async get(ownerId) {
        return this.driver.tableClient.withSessionRetry(async (session) => {
            const res = await session.executeQuery('DECLARE $owner AS Int64; SELECT data FROM conversations WHERE owner_id = $owner;', { '$owner': ydb_sdk_1.TypedValues.int64(ownerId) }, ydb_sdk_1.AUTO_TX);
            const rows = ydb_sdk_1.TypedData.createNativeObjects(res.resultSets[0]);
            return rows[0] ? JSON.parse(rows[0].data) : emptyConversation();
        });
    }
    async compareAndSet(ownerId, expectedVersion, next) {
        return this.driver.tableClient.withSessionRetry(async (session) => {
            const res = await session.executeQuery(`
        DECLARE $owner AS Int64; DECLARE $expected AS Int64; DECLARE $data AS Utf8;
        $old = SELECT version FROM conversations WHERE owner_id = $owner;
        SELECT version FROM $old;
        UPSERT INTO conversations SELECT $owner AS owner_id, $expected + 1 AS version, $data AS data
          FROM AS_TABLE(AsList(AsStruct(1 AS cas_row)))
          WHERE COALESCE((SELECT version FROM $old), 0) = $expected;
      `, { '$owner': ydb_sdk_1.TypedValues.int64(ownerId), '$expected': ydb_sdk_1.TypedValues.int64(expectedVersion),
                '$data': ydb_sdk_1.TypedValues.utf8(JSON.stringify({ ...next, version: expectedVersion + 1 })) }, ydb_sdk_1.AUTO_TX);
            const old = ydb_sdk_1.TypedData.createNativeObjects(res.resultSets[0]);
            return Number(old[0]?.version ?? 0) === expectedVersion;
        });
    }
}
exports.YdbConversationStore = YdbConversationStore;
//# sourceMappingURL=conversation-store.js.map