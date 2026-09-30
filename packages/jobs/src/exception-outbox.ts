import { randomUUID } from 'node:crypto';
import { Driver, AUTO_TX, TypedValues, TypedData, TableDescription, Column, Types, StatusCode } from 'ydb-sdk';
import type { ExceptionOutbox, ExceptionReport } from '@readable-web/observability';

/** Separate from job attempts and delivery checkpoints; one row per code exception. */
export class YdbExceptionOutbox implements ExceptionOutbox {
  private owner = randomUUID();
  constructor(private driver: Driver) {}

  async init(): Promise<void> {
    await this.driver.tableClient.withSession(async session => {
      const status = (error: unknown) => error instanceof Error
        ? (error.constructor as { status?: number }).status : undefined;
      try {
        await session.describeTable('exception_reports');
        return;
      } catch (error) {
        if (![StatusCode.SCHEME_ERROR, StatusCode.NOT_FOUND].includes(status(error) as StatusCode)) throw error;
      }
      try {
        await session.createTable('exception_reports', new TableDescription()
          .withColumn(new Column('id', Types.optional(Types.UTF8)))
          .withColumn(new Column('title', Types.optional(Types.UTF8)))
          .withColumn(new Column('body', Types.optional(Types.UTF8)))
          .withColumn(new Column('lease_owner', Types.optional(Types.UTF8)))
          .withColumn(new Column('lease_expires_at', Types.optional(Types.INT64)))
          .withPrimaryKey('id'));
      } catch (error) {
        if ([StatusCode.ALREADY_EXISTS, StatusCode.SCHEME_ERROR].includes(status(error) as StatusCode)) {
          // Another container may have created it after our initial describe.
          // Verify existence instead of treating every schema error as success.
          await session.describeTable('exception_reports');
          return;
        }
        throw error;
      }
    });
  }

  async save(report: ExceptionReport): Promise<void> {
    await this.driver.tableClient.withSession(session => session.executeQuery(`
      DECLARE $id AS Utf8; DECLARE $title AS Utf8; DECLARE $body AS Utf8;
      UPSERT INTO exception_reports (id, title, body) VALUES ($id, $title, $body);
    `, {
      '$id': TypedValues.utf8(report.id), '$title': TypedValues.utf8(report.title), '$body': TypedValues.utf8(report.body)
    }, AUTO_TX));
  }

  async pending(): Promise<ExceptionReport[]> {
    return this.driver.tableClient.withSession(async session => {
      // Both statements execute in a single serializable transaction. Claims are shared by both services.
      const result = await session.executeQuery(`
        DECLARE $owner AS Utf8; DECLARE $now AS Int64; DECLARE $until AS Int64;
        $available = SELECT id, title, body FROM exception_reports
          WHERE lease_owner = $owner OR lease_expires_at IS NULL OR lease_expires_at < $now
          ORDER BY id LIMIT 10;
        SELECT id, title, body FROM $available;
        UPDATE exception_reports ON SELECT id, $owner AS lease_owner, $until AS lease_expires_at FROM $available;
      `, {
        '$owner': TypedValues.utf8(this.owner), '$now': TypedValues.int64(Date.now()),
        '$until': TypedValues.int64(Date.now() + 300000)
      }, AUTO_TX);
      return TypedData.createNativeObjects(result.resultSets[0]) as unknown as ExceptionReport[];
    });
  }

  async remove(id: string): Promise<void> {
    await this.driver.tableClient.withSession(session => session.executeQuery(`
      DECLARE $id AS Utf8; DECLARE $owner AS Utf8;
      DELETE FROM exception_reports WHERE id = $id AND lease_owner = $owner;
    `, { '$id': TypedValues.utf8(id), '$owner': TypedValues.utf8(this.owner) }, AUTO_TX));
  }
}
