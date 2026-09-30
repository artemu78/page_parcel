"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.YdbExceptionOutbox = void 0;
const node_crypto_1 = require("node:crypto");
const ydb_sdk_1 = require("ydb-sdk");
/** Separate from job attempts and delivery checkpoints; one row per code exception. */
class YdbExceptionOutbox {
    driver;
    owner = (0, node_crypto_1.randomUUID)();
    constructor(driver) {
        this.driver = driver;
    }
    async init() {
        await this.driver.tableClient.withSession(async (session) => {
            const status = (error) => error instanceof Error
                ? error.constructor.status : undefined;
            try {
                await session.describeTable('exception_reports');
                return;
            }
            catch (error) {
                if (![ydb_sdk_1.StatusCode.SCHEME_ERROR, ydb_sdk_1.StatusCode.NOT_FOUND].includes(status(error)))
                    throw error;
            }
            try {
                await session.createTable('exception_reports', new ydb_sdk_1.TableDescription()
                    .withColumn(new ydb_sdk_1.Column('id', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.UTF8)))
                    .withColumn(new ydb_sdk_1.Column('title', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.UTF8)))
                    .withColumn(new ydb_sdk_1.Column('body', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.UTF8)))
                    .withColumn(new ydb_sdk_1.Column('lease_owner', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.UTF8)))
                    .withColumn(new ydb_sdk_1.Column('lease_expires_at', ydb_sdk_1.Types.optional(ydb_sdk_1.Types.INT64)))
                    .withPrimaryKey('id'));
            }
            catch (error) {
                if ([ydb_sdk_1.StatusCode.ALREADY_EXISTS, ydb_sdk_1.StatusCode.SCHEME_ERROR].includes(status(error))) {
                    // Another container may have created it after our initial describe.
                    // Verify existence instead of treating every schema error as success.
                    await session.describeTable('exception_reports');
                    return;
                }
                throw error;
            }
        });
    }
    async save(report) {
        await this.driver.tableClient.withSession(session => session.executeQuery(`
      DECLARE $id AS Utf8; DECLARE $title AS Utf8; DECLARE $body AS Utf8;
      UPSERT INTO exception_reports (id, title, body) VALUES ($id, $title, $body);
    `, {
            '$id': ydb_sdk_1.TypedValues.utf8(report.id), '$title': ydb_sdk_1.TypedValues.utf8(report.title), '$body': ydb_sdk_1.TypedValues.utf8(report.body)
        }, ydb_sdk_1.AUTO_TX));
    }
    async pending() {
        return this.driver.tableClient.withSession(async (session) => {
            // Both statements execute in a single serializable transaction. Claims are shared by both services.
            const result = await session.executeQuery(`
        DECLARE $owner AS Utf8; DECLARE $now AS Int64; DECLARE $until AS Int64;
        $available = SELECT id, title, body FROM exception_reports
          WHERE lease_owner = $owner OR lease_expires_at IS NULL OR lease_expires_at < $now
          ORDER BY id LIMIT 10;
        SELECT id, title, body FROM $available;
        UPDATE exception_reports ON SELECT id, $owner AS lease_owner, $until AS lease_expires_at FROM $available;
      `, {
                '$owner': ydb_sdk_1.TypedValues.utf8(this.owner), '$now': ydb_sdk_1.TypedValues.int64(Date.now()),
                '$until': ydb_sdk_1.TypedValues.int64(Date.now() + 300000)
            }, ydb_sdk_1.AUTO_TX);
            return ydb_sdk_1.TypedData.createNativeObjects(result.resultSets[0]);
        });
    }
    async remove(id) {
        await this.driver.tableClient.withSession(session => session.executeQuery(`
      DECLARE $id AS Utf8; DECLARE $owner AS Utf8;
      DELETE FROM exception_reports WHERE id = $id AND lease_owner = $owner;
    `, { '$id': ydb_sdk_1.TypedValues.utf8(id), '$owner': ydb_sdk_1.TypedValues.utf8(this.owner) }, ydb_sdk_1.AUTO_TX));
    }
}
exports.YdbExceptionOutbox = YdbExceptionOutbox;
//# sourceMappingURL=exception-outbox.js.map