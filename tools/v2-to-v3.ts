#!/usr/bin/env bun
// Convert a format 2 .perch file to format 3. A separate tool on purpose: the
// perch binary reads one format and carries no conversion code.
//
//   bun tools/v2-to-v3.ts old.perch new.perch [--keep-data-steps]
//
// The input is never modified; the output is a fresh, compacted file.
//
// What changed in format 3: the object's code owns its schema, as on
// Cloudflare. Format 2 kept schema migrations in a reserved table and ran them
// itself. This tool moves them into the code:
//
//   1. each migration that defines schema becomes migrations/<name>.sql
//   2. src/schema.ts is generated: it imports those files and runs the ones
//      not yet recorded in a `schema_steps` table
//   3. the class constructor gets one line, migrate(ctx.storage)
//   4. the existing data is marked as already having every step
//
// A migration with no schema statement (INSERTs only) was a data load. Its rows
// are already in the tables, so it is left out of the code; otherwise every new
// copy of the object, and every test, would load that data again.
// --keep-data-steps keeps them as steps anyway.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const keepData = args.includes("--keep-data-steps");
const [input, output] = args.filter((a) => !a.startsWith("--"));
const fail = (m: string): never => {
  console.error(`v2-to-v3: ${m}`);
  process.exit(1);
};
if (!input || !output) fail("usage: bun tools/v2-to-v3.ts old.perch new.perch [--keep-data-steps]");
if (!existsSync(input)) fail(`no file at ${input}`);
if (existsSync(output)) fail(`${output} already exists; choose a new path`);

// A clean, consistent copy to work on (this also folds in any WAL).
{
  const src = new Database(input);
  const v = src.query("SELECT value FROM _perch_meta WHERE key = 'format_version'").get() as { value: string } | null;
  if (!v) fail(`${input} is not a perch file`);
  if (v!.value !== "2") fail(`${input} is format ${v!.value}; this tool converts format 2 only`);
  src.run("VACUUM INTO ?", [output]);
  src.close();
}

const db = new Database(output);
const meta = (k: string) => (db.query("SELECT value FROM _perch_meta WHERE key = ?").get(k) as { value: string } | null)?.value;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const cls = meta("class")!;
const main = meta("main") ?? "src/index.ts";
const live = meta("live_checkin")!;
const manifest: Record<string, string> = JSON.parse((db.query("SELECT manifest FROM _perch_checkins WHERE id = ?").get(live) as { manifest: string }).manifest);
const readText = (path: string) => new TextDecoder().decode((db.query("SELECT data FROM _perch_blobs WHERE hash = ?").get(manifest[path]) as { data: Uint8Array }).data);
const put = (path: string, text: string) => {
  const data = new TextEncoder().encode(text);
  const hash = sha(data);
  db.run("INSERT OR IGNORE INTO _perch_blobs (hash, size, data) VALUES (?, ?, ?)", [hash, data.length, data]);
  manifest[path] = hash;
};

// ---- 1. sort the old migrations into schema steps and data loads
const DDL = /\b(create|alter|drop)\s+(temp\s+|temporary\s+|unique\s+|virtual\s+)?(table|index|view|trigger)\b/i;
const DML = /\b(insert|update|delete|replace)\b/i;
const old = db.query("SELECT seq, name, sql FROM _perch_migrations ORDER BY seq").all() as { seq: number; name: string; sql: string }[];
const steps: { name: string; file: string; sql: string }[] = [];
const dropped: string[] = [];
const mixed: string[] = [];
for (const m of old) {
  const hasDdl = DDL.test(m.sql);
  if (!hasDdl && !keepData) {
    dropped.push(m.name);
    continue;
  }
  if (hasDdl && DML.test(m.sql.replace(/--[^\n]*/g, ""))) mixed.push(m.name);
  let name = m.name.replace(/[^A-Za-z0-9_.-]+/g, "_");
  if (!/^\d/.test(name)) name = `${String(m.seq).padStart(4, "0")}_${name}`;
  steps.push({ name, file: `migrations/${name}.sql`, sql: m.sql });
}

db.run("BEGIN");
let schemaFile: string | null = null;
if (steps.length) {
  // ---- 2. the step files and the generated runner
  for (const s of steps) put(s.file, s.sql);
  schemaFile = "src/schema.ts" in manifest ? "src/perch_schema.ts" : "src/schema.ts";
  const up = "../".repeat(schemaFile.split("/").length - 1);
  put(
    schemaFile,
    `${steps.map((s, i) => `import s${i + 1} from "${up}${s.file}";`).join("\n")}

/** Schema steps, in order. Add a file and an entry; never edit a released step. */
const STEPS: Record<string, string> = {
${steps.map((s, i) => `  ${JSON.stringify(s.name)}: s${i + 1},`).join("\n")}
};

/** Run each step once. The same code runs on Cloudflare and in a .perch file. */
export function migrate(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS schema_steps (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const done = new Set(sql.exec("SELECT name FROM schema_steps").toArray().map((r) => r.name));
    for (const [name, step] of Object.entries(STEPS)) {
      if (done.has(name)) continue;
      sql.exec(step);
      sql.exec("INSERT INTO schema_steps (name, applied_at) VALUES (?, ?)", name, Date.now());
    }
  });
}
`,
  );

  // ---- 3. one line in the class constructor
  if (!(main in manifest)) fail(`the entry file ${main} is not in the live check-in`);
  let code = readText(main);
  const at = code.search(new RegExp(`\\bclass\\s+${cls}\\b`));
  if (at < 0) fail(`could not find class ${cls} in ${main}; add migrate(ctx.storage) to its constructor by hand`);
  const head = code.slice(0, at);
  let body = code.slice(at);
  const ctor = body.match(/constructor\s*\(\s*(\w+)[^)]*\)\s*\{[\s\S]*?super\s*\([^;\n]*\)\s*;?/);
  if (ctor) {
    body = body.replace(ctor[0], `${ctor[0]}\n    migrate(${ctor[1]}.storage);`);
  } else {
    const open = body.indexOf("{");
    body = `${body.slice(0, open + 1)}\n  constructor(ctx: DurableObjectState, env: any) {\n    super(ctx, env);\n    migrate(ctx.storage);\n  }\n${body.slice(open + 1)}`;
  }
  const rel = (() => {
    const from = main.split("/").slice(0, -1);
    const to = schemaFile.replace(/\.ts$/, "").split("/");
    let i = 0;
    while (i < from.length && from[i] === to[i]) i++;
    return ("../".repeat(from.length - i) || "./") + to.slice(i).join("/");
  })();
  put(main, `import { migrate } from "${rel}";\n${head}${body}`);

  // ---- 4. the data already has every step
  db.run("CREATE TABLE IF NOT EXISTS schema_steps (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const s of steps) db.run("INSERT OR IGNORE INTO schema_steps (name, applied_at) VALUES (?, ?)", [s.name, Date.now()]);
}

// ---- a check-in for the converted code
const message = "convert to format 3: schema steps moved into the code";
const created = Date.now();
const id = sha(JSON.stringify({ parent: live, manifest, message, created_at: created }));
db.run("INSERT INTO _perch_checkins (id, parent, manifest, message, created_at) VALUES (?, ?, ?, ?, ?)", [id, live, JSON.stringify(manifest), message, created]);

// ---- the format itself
db.run("DROP TABLE _perch_migrations");
db.run("DROP TABLE IF EXISTS _perch_changes");
db.run("ALTER TABLE _perch_checkins DROP COLUMN schema");
db.run("DELETE FROM _perch_meta WHERE key IN ('api_version', 'main', 'created_at', 'data_epoch')");
db.run("UPDATE _perch_meta SET value = ? WHERE key = 'live_checkin'", [id]);
db.run("UPDATE _perch_meta SET value = '3' WHERE key = 'format_version'");
db.run("COMMIT");
db.run("VACUUM");
db.run("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();

console.log(
  JSON.stringify(
    {
      converted: output,
      from: input,
      checkin: id,
      schema_steps: steps.map((s) => s.file),
      schema_runner: schemaFile,
      constructor_patched: steps.length ? main : null,
      data_loads_left_out: dropped,
      steps_that_also_load_data: mixed,
      notes: [
        ...(dropped.length ? [`${dropped.join(", ")}: data only, so not kept as code. The rows are in the tables. A copy made with \`perch new --like\` starts empty.`] : []),
        ...(mixed.length ? [`${mixed.join(", ")}: these change schema and also write rows, so they were kept whole. Every fresh copy and every stored test will write those rows again; split the file if that is not wanted.`] : []),
        `Check it: perch describe ${output} && perch test ${output}`,
        "A .preview file beside the old object is not converted; discard it.",
      ],
    },
    null,
    2,
  ),
);
