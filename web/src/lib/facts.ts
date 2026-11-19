// Everything the site states about perch, in one place. The tools, the
// commands and the agent guide are not written here: generated.json is the
// binary's own answer (tools/gen-facts.ts), so they cannot drift from it.
import generated from './generated.json';

/** The guide the MCP server hands an agent at initialize. */
export const GUIDE: string = generated.guide;

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
      'format_version (3), name, class and live_checkin, the id of the code that runs. The entry file is always src/index.ts.',
  },
  {
    name: '_perch_blobs',
    columns: 'hash, size, data',
    holds: 'files, content-addressed',
    detail:
      'Every version of every file (code, schema steps, tests, static files), keyed by its SHA-256. A file that does not change between check-ins is stored once.',
  },
  {
    name: '_perch_checkins',
    columns: 'id, parent, manifest, message, created_at',
    holds: 'code history',
    detail:
      'Fossil-style check-ins: a manifest maps each path to a blob hash, parent links the history, and the id is the SHA-256 of the check-in.',
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

export const TOOLS: Tool[] = generated.tools.map((t) => ({ name: t.name, kind: t.kind as Tool['kind'], does: t.description }));

export interface Command {
  usage: string;
  does: string;
}

export const COMMANDS: Command[] = generated.commands.map((c) => ({ usage: c.usage, does: c.about }));

/** What the runtime gives object code today. */
export const RUNTIME: { api: string; note: string }[] = [
  { api: 'public/', note: 'static files served before fetch() without waking the object (Cloudflare Static Assets rules)' },
  { api: 'fetch(request)', note: 'every other HTTP request; import page from "./page.html" for templates' },
  { api: 'public methods', note: 'RPC from the shell, the MCP tools and tests; never over HTTP, as on Cloudflare' },
  { api: 'ctx.storage.sql.exec', note: 'cursor with toArray, one, raw, rowsWritten; the class creates and changes its own tables' },
  { api: 'ctx.storage.get / put / delete / list', note: 'the KV half' },
  { api: 'setAlarm / getAlarm / deleteAlarm, alarm()', note: 'fired on schedule by perch run' },
  { api: 'transactionSync, blockConcurrencyWhile', note: 'atomic writes, guarded startup' },
];

/** Statements object code tried in the end-to-end test, all refused. */
export const REFUSED = [
  'SELECT * FROM _perch_meta',
  "UPDATE _perch_checkins SET message = 'x'",
  'DROP TABLE _perch_kv',
  'CREATE TABLE _perch_sneaky (id TEXT PRIMARY KEY)',
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
  'a check that older code still fits a newer schema (the preview is the check)',
  'moving state to or from Cloudflare (export moves code, not data)',
];
