// Load-test database baseline, counts and restore (the cleanup strategy for registration tests).
//   node scripts/loadtest/dbState.mjs counts
//   node scripts/loadtest/dbState.mjs snapshot            baseline of the tables registration writes
//   node scripts/loadtest/dbState.mjs restore [file]      back to that baseline, then verify
//   node scripts/loadtest/dbState.mjs verify  [file]      compare the database with the baseline
// Runs only against the project in `.env.loadtest` (loadTestEnv.mjs guard). The snapshot is written
// OUTSIDE the repository (default ~/EmlynkWABot-loadtest-artifacts/snapshots).
//
// Restore is exact for registration, which only ADDS rows to these tables: rows that are not in the
// baseline are removed, then every table's checksum must equal the baseline's. audit_logs is
// append-only (a trigger refuses DELETE), so its own trigger is disabled for that one delete, inside
// the same transaction, and enabled again before it commits.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadLoadTestEnv, databaseRef } from "./loadTestEnv.mjs";

// table -> SQL expression of its primary key as text
export const TABLES = Object.freeze({
    candidate: `passport_id`,
    candidate_stages: `passport_id || '/' || stage`,
    audit_logs: `audit_id::text`,
    sheet_sync_queue: `queue_id::text`,
    rate_limits: `key`,
});

export const defaultSnapshotDir = () => process.env.LOADTEST_ARTIFACTS_DIR || path.join(os.homedir(), "EmlynkWABot-loadtest-artifacts", "snapshots");

export async function connect() {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    return client;
}

export async function tableState(client) {
    const state = {};
    for (const [table, pk] of Object.entries(TABLES)) {
        const { rows: [row] } = await client.query(
            `SELECT count(*)::int AS count,
                    md5(coalesce(string_agg(t::text, '|' ORDER BY ${pk}), '')) AS checksum,
                    coalesce(array_agg(${pk}) , '{}') AS keys
               FROM "${table}" t`);
        state[table] = { count: row.count, checksum: row.checksum, keys: row.keys };
    }
    return state;
}

export const countsOf = (state) => Object.fromEntries(Object.entries(state).map(([table, { count }]) => [table, count]));

export async function pgStats(client) {
    const { rows: [row] } = await client.query(`SELECT xact_commit::bigint AS commits, xact_rollback::bigint AS rollbacks FROM pg_stat_database WHERE datname = current_database()`);
    return { commits: Number(row.commits), rollbacks: Number(row.rollbacks) };
}

export async function takeSnapshot(client, dir = defaultSnapshotDir()) {
    const state = await tableState(client);
    const file = path.join(dir, `loadtest-baseline-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ projectRef: databaseRef(process.env.DATABASE_URL), takenAt: new Date().toISOString(), tables: state }, null, 1));
    return { file, counts: countsOf(state) };
}

export const latestSnapshot = (dir = defaultSnapshotDir()) => {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("loadtest-baseline-")).sort() : [];
    return files.length ? path.join(dir, files.at(-1)) : null;
};

function readSnapshot(file) {
    if (!file || !fs.existsSync(file)) throw new Error("No baseline snapshot found. Run: node scripts/loadtest/dbState.mjs snapshot");
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    if (snapshot.projectRef !== databaseRef(process.env.DATABASE_URL)) throw new Error("The snapshot belongs to a different project; refusing to use it.");
    return snapshot;
}

export async function compareWithSnapshot(client, file) {
    const snapshot = readSnapshot(file);
    const now = await tableState(client);
    const report = {};
    for (const table of Object.keys(TABLES)) {
        report[table] = { baseline: snapshot.tables[table].count, now: now[table].count, identical: snapshot.tables[table].checksum === now[table].checksum };
    }
    return { identical: Object.values(report).every((r) => r.identical), report };
}

export async function restoreSnapshot(client, file) {
    const snapshot = readSnapshot(file);
    const keep = (table) => snapshot.tables[table].keys;
    await client.query("BEGIN");
    try {
        // Order matters: audit rows first (no FK action can then touch them), the candidates (cascades
        // their stages; their delete trigger queues "deleted" sync rows), then the queue itself.
        await client.query(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update_delete`);
        await client.query(`DELETE FROM audit_logs WHERE NOT (${TABLES.audit_logs} = ANY($1::text[]))`, [keep("audit_logs")]);
        await client.query(`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update_delete`);
        await client.query(`DELETE FROM candidate WHERE NOT (${TABLES.candidate} = ANY($1::text[]))`, [keep("candidate")]);
        await client.query(`DELETE FROM candidate_stages WHERE NOT (${TABLES.candidate_stages} = ANY($1::text[]))`, [keep("candidate_stages")]);
        await client.query(`DELETE FROM sheet_sync_queue WHERE NOT (${TABLES.sheet_sync_queue} = ANY($1::text[]))`, [keep("sheet_sync_queue")]);
        await client.query(`DELETE FROM rate_limits WHERE NOT (${TABLES.rate_limits} = ANY($1::text[]))`, [keep("rate_limits")]);
        // The unique ID sequence (migration 20261103120000), when present: back to the highest numeric
        // unique_id + 1, so every run starts from the same ID. Safe here: no registration runs during a restore.
        await client.query(`
            SELECT setval('candidate_unique_id_seq', COALESCE((SELECT max(unique_id::BIGINT) FROM candidate WHERE unique_id ~ '^[0-9]{1,18}$'), 0) + 1, false)
             WHERE to_regclass('candidate_unique_id_seq') IS NOT NULL`);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    return compareWithSnapshot(client, file);
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [command, fileArg] = process.argv.slice(2);
    loadLoadTestEnv({ log: (line) => console.error(line) });
    const client = await connect();
    try {
        if (command === "counts") console.log(JSON.stringify(countsOf(await tableState(client))));
        else if (command === "snapshot") console.log(JSON.stringify(await takeSnapshot(client)));
        else if (command === "verify") console.log(JSON.stringify(await compareWithSnapshot(client, fileArg ?? latestSnapshot()), null, 1));
        else if (command === "restore") console.log(JSON.stringify(await restoreSnapshot(client, fileArg ?? latestSnapshot()), null, 1));
        else { console.error("usage: dbState.mjs counts | snapshot | verify [file] | restore [file]"); process.exitCode = 1; }
    } finally {
        await client.end();
    }
}
