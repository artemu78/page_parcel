#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ydb_sdk_1 = require("ydb-sdk");
const REPO_ROOT = process.cwd();
// Map YDB PrimitiveTypeId numbers to human-readable strings
const TYPE_ID_MAP = {};
for (const [key, val] of Object.entries(ydb_sdk_1.Ydb.Type.PrimitiveTypeId)) {
    if (typeof val === 'number') {
        TYPE_ID_MAP[val] = key;
    }
}
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        limit: 10,
        schemaOnly: false,
        dataOnly: false,
        json: false,
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: tsx scripts/ydb-inspect.ts [options]

Inspect Yandex Database (YDB) schemas and stored data.

Options:
  --table, -t <name>    Inspect a specific table only (e.g. --table Users)
  --limit, -l <n>       Max rows to fetch per table (default: 10)
  --schema-only         Only output table schemas (skip row data)
  --data-only           Only output row data (skip schema column details)
  --json                Output results as structured JSON
  --help, -h            Show this help message

Environment Variables:
  YDB_ENDPOINT                          YDB gRPC endpoint (default: grpcs://ydb.serverless.yandexcloud.net:2135)
  YDB_DATABASE                          Database path
  YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS  Path to authorized service account JSON key
      `);
            process.exit(0);
        }
        else if (arg === '--table' || arg === '-t') {
            options.table = args[++i];
        }
        else if (arg === '--limit' || arg === '-l') {
            options.limit = parseInt(args[++i], 10) || 10;
        }
        else if (arg === '--schema-only') {
            options.schemaOnly = true;
        }
        else if (arg === '--data-only') {
            options.dataOnly = true;
        }
        else if (arg === '--json') {
            options.json = true;
        }
    }
    return options;
}
function resolveConfig() {
    let endpoint = process.env.YDB_ENDPOINT || 'grpcs://ydb.serverless.yandexcloud.net:2135';
    if (!endpoint.startsWith('grpcs://') && !endpoint.startsWith('grpc://')) {
        endpoint = `grpcs://${endpoint}`;
    }
    let database = process.env.YDB_DATABASE;
    if (!database) {
        const tfStatePath = path_1.default.join(REPO_ROOT, 'infra', 'yandex', 'terraform.tfstate');
        if (fs_1.default.existsSync(tfStatePath)) {
            try {
                const tfState = JSON.parse(fs_1.default.readFileSync(tfStatePath, 'utf8'));
                const dbResource = tfState.resources?.find((r) => r.type === 'yandex_ydb_database_serverless' && r.name === 'db');
                if (dbResource?.instances?.[0]?.attributes?.database_path) {
                    database = dbResource.instances[0].attributes.database_path;
                }
            }
            catch {
                // Ignore JSON parse errors
            }
        }
    }
    if (!database) {
        database = '/ru-central1/b1g2vhk5e81ojfubiddd/etn8q0fueuk64196c78h';
    }
    if (!process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS) {
        const defaultSaKey = path_1.default.join(REPO_ROOT, 'infra', 'yandex', 'authorized_key.json');
        if (fs_1.default.existsSync(defaultSaKey)) {
            process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS = defaultSaKey;
        }
    }
    return { endpoint, database };
}
function formatColumnType(colType) {
    if (!colType)
        return 'UNKNOWN';
    if (colType.optionalType) {
        const inner = formatColumnType(colType.optionalType.item);
        return `${inner}?`;
    }
    if (colType.typeId !== undefined) {
        return TYPE_ID_MAP[colType.typeId] || `TYPE_${colType.typeId}`;
    }
    return JSON.stringify(colType);
}
function serializeValue(val) {
    if (val === null || val === undefined)
        return null;
    if (typeof val === 'object') {
        if (val.low !== undefined && val.high !== undefined) {
            // Protobuf Long
            return val.toString();
        }
        if (val instanceof Date) {
            return val.toISOString();
        }
        if (Array.isArray(val)) {
            return val.map(serializeValue);
        }
        const cleanObj = {};
        for (const [k, v] of Object.entries(val)) {
            cleanObj[k] = serializeValue(v);
        }
        return cleanObj;
    }
    return val;
}
async function main() {
    const options = parseArgs();
    const config = resolveConfig();
    const driver = new ydb_sdk_1.Driver({
        endpoint: config.endpoint,
        database: config.database,
        authService: (0, ydb_sdk_1.getCredentialsFromEnv)()
    });
    const ready = await driver.ready(8000).catch(() => false);
    if (!ready) {
        console.error(`❌ Could not connect to YDB at ${config.endpoint} (database: ${config.database})`);
        process.exit(1);
    }
    try {
        const dirResult = await driver.schemeClient.listDirectory('');
        let tables = dirResult.children
            .filter((c) => c.name && !c.name.startsWith('.sys'))
            .map((c) => c.name);
        if (options.table) {
            if (!tables.includes(options.table)) {
                console.error(`❌ Table "${options.table}" not found in database. Available tables: ${tables.join(', ')}`);
                process.exit(1);
            }
            tables = [options.table];
        }
        const outputReport = {};
        await driver.tableClient.withSession(async (session) => {
            for (const tableName of tables) {
                const desc = await session.describeTable(tableName);
                const primaryKeys = desc.primaryKey || [];
                const columns = (desc.columns || []).map((col) => ({
                    name: col.name,
                    type: formatColumnType(col.type),
                    isPrimaryKey: primaryKeys.includes(col.name)
                }));
                let rows = [];
                let totalCount = null;
                if (!options.schemaOnly) {
                    try {
                        const countRes = await session.executeQuery(`SELECT COUNT(*) AS cnt FROM \`${tableName}\`;`, {}, ydb_sdk_1.AUTO_TX);
                        const countRows = ydb_sdk_1.TypedData.createNativeObjects(countRes.resultSets[0]);
                        if (countRows.length > 0 && countRows[0].cnt !== undefined) {
                            totalCount = serializeValue(countRows[0].cnt);
                        }
                    }
                    catch {
                        // Count query not supported or failed
                    }
                    const query = `SELECT * FROM \`${tableName}\` LIMIT ${options.limit};`;
                    const dataRes = await session.executeQuery(query, {}, ydb_sdk_1.AUTO_TX);
                    const rawRows = ydb_sdk_1.TypedData.createNativeObjects(dataRes.resultSets[0]);
                    rows = rawRows.map(serializeValue);
                }
                outputReport[tableName] = {
                    primaryKeys,
                    columns,
                    totalCount,
                    sampleRowCount: rows.length,
                    rows
                };
                if (!options.json) {
                    console.log(`\n======================================================================`);
                    console.log(`📊 TABLE: ${tableName}`);
                    console.log(`======================================================================`);
                    console.log(`🔑 Primary Key: [${primaryKeys.join(', ')}]`);
                    if (!options.dataOnly) {
                        console.log(`\n📋 Columns (${columns.length}):`);
                        for (const col of columns) {
                            const pkFlag = col.isPrimaryKey ? ' [PK]' : '';
                            console.log(`  - ${col.name.padEnd(20)} : ${col.type}${pkFlag}`);
                        }
                    }
                    if (!options.schemaOnly) {
                        const countStr = totalCount !== null ? ` (Total rows in table: ${totalCount})` : '';
                        console.log(`\n📦 Sample Data (Limit ${options.limit})${countStr}:`);
                        if (rows.length === 0) {
                            console.log(`  (empty table)`);
                        }
                        else {
                            console.log(JSON.stringify(rows, null, 2));
                        }
                    }
                }
            }
        });
        if (options.json) {
            console.log(JSON.stringify({
                database: config.database,
                endpoint: config.endpoint,
                tables: outputReport
            }, null, 2));
        }
    }
    finally {
        try {
            await Promise.race([
                driver.destroy(),
                new Promise((resolve) => setTimeout(resolve, 1000))
            ]);
        }
        catch {
            // ignore
        }
        process.exit(0);
    }
}
main().catch((err) => {
    console.error('❌ YDB Inspection Error:', err);
    process.exit(1);
});
//# sourceMappingURL=ydb-inspect.js.map