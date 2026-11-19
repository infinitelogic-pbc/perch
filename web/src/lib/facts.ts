// Everything the site states about perch, in one place, so the pages and
// /llms.txt cannot drift apart. Each entry is checked against perch/src/*.rs,
// perch/js/bootstrap.js and perch/test/*.ts as of v0.1.0.

export const TAGLINE = 'One SQLite file holding a Durable Object’s code and data.';

export interface Table {
  name: string;
  columns: string;
  holds: string;
  detail: string;
}

/** The reserved tables, in the order store.rs creates them. */
export const RESERVED: Table[] = [
  {
    name: '_perch_meta',
    columns: 'key, value',
    holds: 'name, class, live check-in',
    detail:
      'format_version (2), api_version (perch-v0), name, class, main (src/index.ts), created_at and live_checkin, the id of the code that runs.',
  },
  {
    name: '_perch_blobs',
    columns: 'hash, size, data',
    holds: 'code, content-addressed',
    detail:
      'Every source file version, keyed by its SHA-256. A file that does not change between check-ins is stored once.',
  },
  {
    name: '_perch_checkins',
    columns: 'id, parent, manifest, message, created_at, schema',
    holds: 'code history',
    detail:
      'Fossil-style check-ins: a manifest maps each path to a blob hash, parent links the history, and the id is the SHA-256 of the check-in. schema snapshots the data tables the code was released against, which is what rollback checks.',
  },
  {
    name: '_perch_migrations',
    columns: 'seq, name, sql, checkin, applied_at',
    holds: 'forward-only schema',
    detail:
      'Ordered SQL migrations, each tied to the check-in that brought it. They only move forward; nothing undoes one.',
  },
  {
    name: '_perch_kv',
    columns: 'key, value',
    holds: 'ctx.storage.get / put',
    detail:
      'The key-value half of storage. Values are UTF-8 JSON that any runtime can read; Date, Map, Set, bytes, bigint and the rest are tagged with $perch, so what structuredClone accepts round-trips (cycles are refused).',
  },
  {
    name: '_perch_alarms',
    columns: 'id = 1, scheduled_at, retry_count',
    holds: 'the next alarm',
    detail: 'At most one row: when alarm() is due next. ctx.storage.setAlarm writes it.',
  },
];

export interface Tool {
  name: string;
  kind: 'read' | 'write' | 'destructive';
  does: string;
}

export const TOOLS: Tool[] = [
  { name: 'describe_object', kind: 'read', does: 'Name, class, live check-in, tables with columns and row counts, files, next alarm, preview state. Start here.' },
  { name: 'read_code', kind: 'read', does: 'Files at the live check-in, the preview, or any check-in id (a 4+ character prefix works). Binary files come back as base64.' },
  { name: 'list_checkins', kind: 'read', does: 'History, newest first, with the migrations each check-in added. Unified diffs on request.' },
  { name: 'query_data', kind: 'read', does: 'Read-only SQL over the object’s own tables, live or preview. At most 500 rows.' },
  { name: 'propose_change', kind: 'destructive', does: 'Changes the preview copy only. Whole files, exact-string edits and new migrations, applied to a preview copy of the file (live data included), built there, stored tests run. Proposals stack; restart starts over from live.' },
  { name: 'test_call', kind: 'destructive', does: 'A write call on the preview copy: POST, PUT, PATCH or DELETE to fetch(), an RPC method, or alarm(). Returns the result, console logs and the rows each table gained, changed or lost.' },
  { name: 'read_object', kind: 'read', does: 'A read of live or the preview: GET or HEAD to fetch() or public/, or an RPC method. The runtime refuses any write made during it and saves nothing.' },
  { name: 'import_files', kind: 'destructive', does: 'Imports a directory of static files from disk into public/ on the live object, as one check-in. Files stream from disk, so tens of thousands are fine and none pass through the agent.' },
  { name: 'run_tests', kind: 'read', does: 'Runs the object’s test/*.ts files. Each test gets its own fresh, empty copy of the object and a clock it controls.' },
  { name: 'release_change', kind: 'destructive', does: 'Runs the preview’s migrations on the live file and moves live to its code, squashed into one check-in, in one transaction. Refused if the preview did not build, a stored test fails, or live moved.' },
  { name: 'rollback_code', kind: 'destructive', does: 'Moves live back to an earlier check-in. Code only, never schema: refused when that code no longer fits the tables.' },
  { name: 'call_object', kind: 'destructive', does: 'A write call on the live object: POST, PUT, PATCH or DELETE to fetch(), or an RPC method.' },
];

export interface Command {
  usage: string;
  does: string;
}

export const COMMANDS: Command[] = [
  { usage: 'perch new <file> [--class C] [--name N] [--from DIR | --like FILE]', does: 'Create an object file: an empty class, or src/**, public/** and migrations/*.sql from a directory. With --like, a copy of another object without its data: the same code, static files, tests and table definitions, with empty tables and no history.' },
  { usage: 'perch run <file> [--port 8787] [--host 127.0.0.1] [--no-alarms]', does: 'Serve it over HTTP and fire its alarms.' },
  { usage: 'perch mcp <file>', does: 'The MCP server, over stdio.' },
  { usage: 'perch describe <file>', does: 'The description as JSON.' },
  { usage: 'perch checkins <file> [--limit 20] [--diffs]', does: 'Code history.' },
  { usage: 'perch call <file> <method> [json-args]', does: 'Call an RPC method on the live object.' },
  { usage: 'perch fetch <file> <path> [-X METHOD] [-d BODY]', does: 'Send one request to the live object’s fetch().' },
  { usage: 'perch import <file> <dir> [--into public/img/] [--prune]', does: 'Import a directory of static files into public/, streaming from disk. One check-in; unchanged files are skipped.' },
  { usage: 'perch test <file>', does: 'Run the stored tests, each on a fresh empty copy. Exit 1 on failure.' },
  { usage: 'perch export <file> <out> [--worker-name W]', does: 'Write the live code as a Wrangler project.' },
];

/** What the runtime gives object code today. */
export const RUNTIME: { api: string; note: string }[] = [
  { api: 'public/', note: 'static files served before fetch() without waking the object (Cloudflare Static Assets rules)' },
  { api: 'fetch(request)', note: 'every other HTTP request; import page from "./page.html" for templates' },
  { api: 'public methods', note: 'RPC, also POST /.perch/rpc/<method> with a JSON array of args' },
  { api: 'ctx.storage.sql.exec', note: 'cursor with toArray, one, raw, rowsWritten' },
  { api: 'ctx.storage.get / put / delete / list', note: 'the KV half' },
  { api: 'setAlarm / getAlarm / deleteAlarm, alarm()', note: 'fired on schedule by perch run' },
  { api: 'transactionSync, blockConcurrencyWhile', note: 'atomic writes, guarded startup' },
];

/** Statements object code tried in the end-to-end test, all refused. */
export const REFUSED = [
  'SELECT * FROM _perch_meta',
  "UPDATE _perch_checkins SET message = 'x'",
  'DROP TABLE todos',
  'CREATE TABLE sneaky (id TEXT PRIMARY KEY)',
  'BEGIN',
  "ATTACH DATABASE '/tmp/x.db' AS x",
  'PRAGMA journal_mode = DELETE',
];

export const NOT_YET = [
  'WebSockets',
  'env bindings and outbound fetch',
  'npm imports (relative imports between the object’s own files work)',
  'a server mode hosting many object files',
  'sync between copies of a file',
  'a history of data changes, or undo',
  'moving state to or from Cloudflare (export moves code and migrations, not data)',
];
