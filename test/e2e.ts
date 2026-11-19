// End-to-end check of the first deliverable: build the to-do object entirely
// through the MCP tools, then serve it, fire its alarm, carry the file to
// another directory, roll back a bad release, and confirm the sandbox holds.
//
//   bun test/e2e.ts            (after cargo build)

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const ROOT = join(import.meta.dir, "..");
const PERCH = process.env.PERCH ?? join(ROOT, "target/debug/perch");
const dir = mkdtempSync(join(tmpdir(), "perch-e2e-"));
const file = join(dir, "todo.perch");

let passed = 0;
function ok(cond: unknown, what: string) {
  if (!cond) {
    console.error(`FAIL ${what}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok   ${what}`);
}

function sh(args: string[]): any {
  const r = Bun.spawnSync([PERCH, ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`perch ${args.join(" ")}: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString());
}

// As sh, for commands expected to fail: returns the exit code and any JSON printed.
function shFail(args: string[]): { code: number; out: any } {
  const p = Bun.spawnSync([PERCH, ...args], { stderr: "pipe" });
  let out: any = null;
  try { out = JSON.parse(p.stdout.toString()); } catch {}
  return { code: p.exitCode, out };
}

class Mcp {
  proc: ChildProcess;
  next = 1;
  waiting = new Map<number, (v: any) => void>();
  constructor(path: string) {
    this.proc = spawn(PERCH, ["mcp", path], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.proc.stdout! }).on("line", (line) => {
      const msg = JSON.parse(line);
      this.waiting.get(msg.id)?.(msg);
      this.waiting.delete(msg.id);
    });
  }
  rpc(method: string, params: any = {}): Promise<any> {
    const id = this.next++;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((r) => this.waiting.set(id, r));
  }
  async tool(name: string, args: any = {}): Promise<{ v: any; isError: boolean; text: string }> {
    const m = await this.rpc("tools/call", { name, arguments: args });
    const r = m.result;
    if (r.isError && process.env.VERBOSE) console.error(`  (${name} error) ${r.content[0].text}`);
    return { v: r.structuredContent ?? {}, isError: r.isError, text: r.content[0].text };
  }
  close() { this.proc.kill(); }
}

const src = (p: string) => readFileSync(join(ROOT, "examples/todo", p), "utf8");
// The to-do object's code: the class, its helpers, and its schema steps.
const TODO = Object.fromEntries(["src/index.ts", "src/uuid.ts", "src/stats.html", "src/schema.ts", "migrations/0001_todos.sql"].map((p) => [p, src(p)]));

// ------------------------------------------------------------------ build over MCP
sh(["new", file, "--class", "Todo"]);
const mcp = new Mcp(file);
const init = await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
ok(init.result.instructions.includes("propose_change"), "initialize returns the agent guide");
const list = await mcp.rpc("tools/list");
const names = list.result.tools.map((t: any) => t.name);
ok(names.length === 8, `eight tools (${names.join(", ")})`);
ok(list.result.tools.every((t: any) => t.title && t.annotations), "every tool has a title and annotations");
const ann = Object.fromEntries(list.result.tools.map((t: any) => [t.name, t.annotations]));
ok(list.result.tools.every((t: any) => (t.annotations.readOnlyHint === true) !== (t.annotations.destructiveHint === true)), "every tool is exactly one of readOnlyHint or destructiveHint");
const READS = ["describe_object", "read_code", "query_data", "read_object"];
ok(names.every((n: string) => READS.includes(n) === (ann[n].readOnlyHint === true)) && names.every((n: string) => n.length <= 64), "the read-only set is the four read tools; names are within 64 characters");
const props = (n: string) => list.result.tools.find((t: any) => t.name === n).inputSchema.properties;
ok(!props("call_object").http_method.enum.includes("GET") && props("read_object").http_method.enum.join() === "GET,HEAD", "no tool accepts both safe and unsafe HTTP methods");

let r = await mcp.tool("propose_change", { message: "old habit", migrations: [{ name: "0001_todos", sql: src("migrations/0001_todos.sql") }] });
ok(r.isError && r.text.includes("schema lives in the object's code"), "propose_change takes no migrations, and says where schema goes");
r = await mcp.tool("propose_change", { message: "to-do API with nightly cleanup", files: TODO });
ok(!r.isError && r.v.build.ok, `propose_change builds on the preview (${r.v.checkin?.slice(0, 12)})`);
ok(r.v.schema.todos && r.v.schema.schema_steps, "the constructor built the tables on the preview");

r = await mcp.tool("call_object", { target: "preview", kind: "fetch", http_method: "POST", path: "/todos", body: { title: "buy milk" } });
ok(r.v.ok && r.v.status === 201 && r.v.json.title === "buy milk" && r.v.target === "preview", "call_object POST /todos on the preview");
ok(r.v.rows_written === 1, "a write call reports the rows it wrote");
r = await mcp.tool("read_object", { target: "preview", kind: "rpc", method: "stats" });
ok(r.v.result.total === 1, "read_object rpc stats on the preview");
r = await mcp.tool("query_data", { sql: "SELECT count(*) AS n FROM todos" });
ok(r.isError && r.text.includes("no such table"), "live is untouched: the schema was only built on the preview");
r = await mcp.tool("query_data", { sql: "SELECT count(*) AS n FROM todos", target: "preview" });
ok(r.v.rows[0][0] === 1, "query_data can read the preview");
r = await mcp.tool("describe_object", { target: "preview" });
ok(r.v.target === "preview" && r.v.next_alarm && r.v.tables.some((t: any) => t.name === "todos" && t.rows === 1), "describe_object can describe the preview, alarm included");
r = await mcp.tool("call_object", { kind: "alarm" });
ok(r.isError && r.text.includes("preview"), "an alarm is not run by hand on live");
r = await mcp.tool("call_object", { target: "preview", kind: "alarm" });
ok(r.v.ok && r.v.next_alarm && r.v.next_alarm.at_ms > Date.now() + 60_000, "a hand-run alarm that reschedules itself keeps its next alarm");

// ------------------------------------------------------------------ the sandbox
r = await mcp.tool("propose_change", {
  message: "probe the sandbox",
  files: {
    "src/evil.ts": `export function tryIt(sql: any, q: string) { try { sql.exec(q); return "allowed"; } catch (e) { return String(e.message || e); } }`,
    "src/index.ts": src("src/index.ts").replace('import { uuidv7 } from "./uuid";', 'import { uuidv7 } from "./uuid";\nimport { tryIt } from "./evil";')
      .replace("  // ---- RPC", "  probe(q: string) { return tryIt(this.ctx.storage.sql, q); }\n\n  // ---- RPC"),
  },
});
ok(r.v.build.ok && r.v.stacked_on_previous_preview, "second proposal stacks on the preview");
for (const q of [
  "SELECT * FROM _perch_meta",
  "UPDATE _perch_checkins SET message = 'x'",
  "DELETE FROM _perch_kv",
  "DROP TABLE _perch_kv",
  "CREATE TABLE _perch_sneaky (id TEXT PRIMARY KEY)",
  "CREATE INDEX sneaky ON _perch_blobs (size)",
  "BEGIN",
  "ATTACH DATABASE '/tmp/x.db' AS x",
  "PRAGMA journal_mode = DELETE",
  "PRAGMA writable_schema = ON",
]) {
  r = await mcp.tool("call_object", { target: "preview", kind: "rpc", method: "probe", args: [q] });
  ok(r.v.result !== "allowed" && /not authorized|prohibited/i.test(r.v.result), `object code refused: ${q}`);
}
// Its own schema is the code's to change, as on Cloudflare.
for (const q of ["CREATE TABLE scratch (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)", "CREATE INDEX scratch_v ON scratch (v)", "ALTER TABLE scratch ADD COLUMN w TEXT", "DROP TABLE scratch"]) {
  r = await mcp.tool("call_object", { target: "preview", kind: "rpc", method: "probe", args: [q] });
  ok(r.v.result === "allowed", `object code may change its own schema: ${q}`);
}
r = await mcp.tool("read_object", { target: "preview", kind: "rpc", method: "probe", args: ["CREATE TABLE during_read (id TEXT)"] });
ok(r.v.result !== "allowed", "a read call cannot change the schema");
r = await mcp.tool("query_data", { sql: "SELECT * FROM _perch_checkins" });
ok(r.isError, "query_data refuses reserved tables");
r = await mcp.tool("query_data", { sql: "DELETE FROM todos", target: "preview" });
ok(r.isError && /not authorized|readonly/i.test(r.text), "query_data refuses writes");
r = await mcp.tool("query_data", { sql: "CREATE TABLE q (id TEXT)", target: "preview" });
ok(r.isError, "query_data refuses schema changes");

// Discard the probe: start over from live with the clean code.
r = await mcp.tool("propose_change", { restart: true, message: "to-do API with nightly cleanup", files: TODO });
ok(r.v.build.ok && !r.v.stacked_on_previous_preview, "restart starts from live");
r = await mcp.tool("release_change", {});
ok(!r.isError && r.v.released, `release_change moves live (${r.v.released?.slice(0, 12)})`);
const good = r.v.released as string;
r = await mcp.tool("describe_object");
ok(r.v.live_checkin.id === good && r.v.tables.some((t: any) => t.name === "todos") && !r.v.preview.exists, "describe_object shows the release");

r = await mcp.tool("call_object", { kind: "rpc", method: "add", args: ["write tests"] });
ok(r.v.ok && r.v.result.title === "write tests", "call_object rpc on live");
ok(sh(["describe", file]).next_alarm, "first live event ran the constructor, which scheduled the nightly alarm");
r = await mcp.tool("describe_object");
ok(r.v.checkins.total === 2 && r.v.checkins.recent[0].live && r.v.checkins.recent[0].id === good && r.v.checkins.recent[1].message === "new object", "describe_object carries the code history");

// ------------------------------------------------------------------ perch run: HTTP + RPC + alarm
async function serve(path: string, port: number): Promise<ChildProcess> {
  const p = spawn(PERCH, ["run", path, "--port", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
  p.stderr!.on("data", (d) => process.env.VERBOSE && process.stderr.write(d));
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/todos`); return p; } catch { await Bun.sleep(50); }
  }
  throw new Error("perch run did not start");
}
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let run = await serve(file, port);
let res = await fetch(`${base}/todos`, { method: "POST", body: JSON.stringify({ title: "ship perch" }), headers: { "content-type": "application/json" } });
const shipped = await res.json();
ok(res.status === 201 && shipped.title === "ship perch", "HTTP POST /todos");
res = await fetch(`${base}/todos/${shipped.id}`, { method: "PATCH", body: JSON.stringify({ done: true }) });
ok((await res.json()).done === 1, "HTTP PATCH marks done");
res = await fetch(`${base}/todos?done=0`);
const open = await res.json();
ok(open.length === 1 && open[0].title === "write tests", "HTTP GET with query filter");
res = await fetch(`${base}/api/stats`);
let stats = await res.json();
ok(stats.total === 2 && stats.done === 1, "a route the class defines returns the right data");
res = await fetch(`${base}/.perch/rpc/stats`, { method: "POST", body: "[]" });
ok(res.status === 404, "methods are not reachable over HTTP: only what fetch() routes");

await fetch(`${base}/api/cleanup`, { method: "POST", body: JSON.stringify({ retentionMs: 0, inMs: 300 }) });
await Bun.sleep(1200);
stats = await (await fetch(`${base}/api/stats`)).json();
ok(stats.total === 1 && stats.done === 0 && stats.lastCleanup, "alarm fired on schedule and its writes show up in the data");
const d = sh(["describe", file]);
ok(d.next_alarm && d.next_alarm.at_ms > Date.now() + 60_000, "alarm rescheduled itself for midnight");

// ------------------------------------------------------------------ bad release, rollback, schema steps
r = await mcp.tool("propose_change", {
  message: "oops: break listing",
  files: { "src/index.ts": src("src/index.ts").replace('if (request.method === "GET" && !id) {', 'if (request.method === "GET" && !id) {\n      throw new Error("listing broke");') },
});
ok(r.v.build.ok, "a broken handler still builds");
r = await mcp.tool("release_change", {});
const bad = r.v.released;
res = await fetch(`${base}/todos`);
ok(res.status === 500 && (await res.text()).includes("listing broke"), "running server picked up the bad release");
r = await mcp.tool("propose_change", { message: "back to the good code", from_checkin: good.slice(0, 10) });
ok(r.v.build.ok && r.v.files_changed.includes("src/index.ts") && r.v.from_checkin === good, "propose_change from_checkin starts from an earlier check-in's files");
r = await mcp.tool("release_change", {});
ok(!r.isError, "the rollback is released like any change");
res = await fetch(`${base}/todos`);
ok(res.status === 200 && (await res.json()).length === 1, "running server serves the rolled-back code");

// A schema step: a new file, imported and listed. It runs on the preview's
// copy of the data, then on live at release.
const withStep = (name: string, sql: string, n: number) => ({
  files: { [`migrations/${name}.sql`]: sql },
  edits: [
    { path: "src/schema.ts", old: "\n\n/** Schema steps", new: `\nimport s${n} from "../migrations/${name}.sql";\n\n/** Schema steps` },
    { path: "src/schema.ts", old: "\n};", new: `\n  "${name}": s${n},\n};` },
  ],
});
r = await mcp.tool("propose_change", { message: "notes on items", ...withStep("0002_note", "ALTER TABLE todos ADD COLUMN note TEXT;", 2) });
ok(r.v.build.ok && r.v.schema.todos.some((c: any) => c.name === "note"), "a new schema step runs on the preview when its constructor runs");
r = await mcp.tool("query_data", { sql: "SELECT note FROM todos" });
ok(r.isError, "live does not have the column yet");
r = await mcp.tool("release_change", { message: "notes on items" });
const noted = r.v.released;
ok(!r.isError && r.v.schema.todos.some((c: any) => c.name === "note"), "release starts the new code on live, which applies the step");
r = await mcp.tool("query_data", { sql: "SELECT title, note FROM todos" });
ok(r.v.rows.length === 1 && r.v.rows[0][0] === "write tests" && r.v.rows[0][1] === null, "the live rows are kept, with the new column");
res = await fetch(`${base}/todos`);
ok(res.status === 200 && "note" in (await res.json())[0], "the running server picked up the new schema");

// A step that is fine on the preview but fails on live, because live data
// changed in between: the release is undone.
r = await mcp.tool("propose_change", { message: "unique titles", ...withStep("0003_unique", "CREATE UNIQUE INDEX todos_title ON todos (title);", 3) });
ok(r.v.build.ok, "a unique index builds on the preview's copy of the data");
await mcp.tool("call_object", { kind: "rpc", method: "add", args: ["write tests"] });
r = await mcp.tool("release_change", {});
ok(r.isError && r.text.includes("release undone") && /UNIQUE/i.test(r.text), "a constructor that fails on live undoes the release");
r = await mcp.tool("describe_object");
ok(r.v.live_checkin.id === noted && r.v.checkins.recent[0].id === noted, "live keeps the code it had, and the failed check-in is gone");
r = await mcp.tool("read_object", { kind: "rpc", method: "stats" });
ok(r.v.ok && r.v.result.total === 2, "the live object still runs");
r = await mcp.tool("query_data", { sql: "SELECT count(*) FROM schema_steps" });
ok(r.v.rows[0][0] === 2, "the failed step left nothing behind");
// Rebuilt from live, the same step now fails where it should: on the preview.
r = await mcp.tool("propose_change", { restart: true, message: "unique titles", ...withStep("0003_unique", "CREATE UNIQUE INDEX todos_title ON todos (title);", 3) });
ok(r.isError && !r.v.build.ok && /UNIQUE/i.test(r.v.build.error), "a step that fails on real rows fails on the preview, before release");
r = await mcp.tool("release_change", {});
ok(r.isError && r.text.includes("did not build"), "a preview that did not build cannot be released");
// Older code on a newer schema: nothing checks the fit; the preview is the test.
r = await mcp.tool("propose_change", { restart: true, message: "back before notes", from_checkin: good });
ok(r.v.build.ok && r.v.schema.todos.some((c: any) => c.name === "note"), "rolling code back leaves the schema as it is");
run.kill();
mcp.close();

// ------------------------------------------------------------------ carry the file
const dir2 = mkdtempSync(join(tmpdir(), "perch-carry-"));
const file2 = join(dir2, "todo.perch");
// Only the .perch file travels: every commit checkpoints the WAL into it.
copyFileSync(file, file2);
const port2 = port + 1;
run = await serve(file2, port2);
const listed = await (await fetch(`http://127.0.0.1:${port2}/todos`)).json();
ok(listed.length === 2 && listed[0].title === "write tests", "copied file serves the same code and data");
const d2 = sh(["describe", file2]);
ok(d2.live_checkin.id === sh(["describe", file]).live_checkin.id, "same live check-in after the copy");
run.kill();

ok(d2.checkins.total === 5, `history kept (${d2.checkins.total} check-ins)`);

// ------------------------------------------------------------------ static files and text imports
const site = join(dir, "site.perch");
sh(["new", site, "--class", "Site"]);
const m2 = new Mcp(site);
await m2.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
const PNG = readFileSync(join(ROOT, "examples/todo/public/logo.png"));
r = await m2.tool("propose_change", {
  message: "a site whose constructor throws",
  files: {
    "src/index.ts": `import { DurableObject } from "cloudflare:workers";
import page from "./hello.html";
export class Site extends DurableObject {
  constructor(ctx: any, env: any) { super(ctx, env); if (!(globalThis as any).ALLOW) throw new Error("boom in constructor"); }
  async fetch() { return new Response(page, { headers: { "content-type": "text/html" } }); }
}`,
    "src/hello.html": "<h1>dynamic</h1>",
    "public/index.html": "<h1>home</h1>",
    "public/about.html": "<h1>about</h1>",
    "public/docs/index.html": "<h1>docs</h1>",
    "public/logo.png": { base64: PNG.toString("base64") },
  },
});
ok(!r.v.build.ok && r.v.build.error.includes("boom in constructor"), "a throwing constructor fails the build");
const get = (path: string, extra: any = {}) =>
  extra.http_method === "POST"
    ? m2.tool("call_object", { kind: "fetch", path, target: "preview", ...extra })
    : m2.tool("read_object", { kind: "fetch", path, target: "preview", ...extra });
r = await get("/");
ok(r.v.status === 200 && r.v.body === "<h1>home</h1>" && r.v.asset === "public/index.html", "/ serves public/index.html without waking the broken object");
ok(r.v.rows_written === 0 && r.v.logs.length === 0, "a static file runs no event (no writes, no logs)");
const cases: [string, number, string][] = [
  ["/index.html", 307, "/"],
  ["/about", 200, "<h1>about</h1>"],
  ["/about.html", 307, "/about"],
  ["/about/", 307, "/about"],
  ["/docs", 307, "/docs/"],
  ["/docs/", 200, "<h1>docs</h1>"],
  ["/docs/index.html", 307, "/docs/"],
  ["/about.html?x=1", 307, "/about?x=1"],
];
for (const [path, status, want] of cases) {
  r = await get(path);
  const got = status === 307 ? r.v.headers.find((h: string[]) => h[0] === "location")?.[1] : r.v.body;
  ok(r.v.status === status && got === want, `${path} → ${status} ${want}`);
}
r = await get("/logo.png");
ok(r.v.status === 200 && r.v.headers.some((h: string[]) => h[0] === "content-type" && h[1] === "image/png"), "binary file served as image/png");
const etag = r.v.headers.find((h: string[]) => h[0] === "etag")[1];
r = await get("/logo.png", { headers: { "if-none-match": etag } });
ok(r.v.status === 304, "If-None-Match gets a 304");
r = await get("/logo.png", { http_method: "HEAD" });
ok(r.v.status === 200 && r.v.body === "", "HEAD returns headers only");
r = await get("/about", { http_method: "POST", body: "x" });
ok(!r.v.ok && /boom in constructor/.test(r.text), "non-GET methods go to fetch() (and hit the broken constructor)");
r = await get("/missing");
ok(/boom in constructor/.test(r.text), "a miss goes to fetch()");

r = await m2.tool("propose_change", {
  message: "fix the constructor",
  files: { "src/index.ts": `import { DurableObject } from "cloudflare:workers";
import page from "./hello.html";
export class Site extends DurableObject {
  async fetch() { return new Response(page, { headers: { "content-type": "text/html" } }); }
}` },
});
ok(r.v.build.ok, "fixed constructor builds");
r = await get("/missing");
ok(r.v.status === 200 && r.v.body === "<h1>dynamic</h1>" && !r.v.asset, "fetch() renders an imported .html template");
r = await m2.tool("read_code", { checkin: "preview", path: "public/logo.png" });
ok(Buffer.from(r.v.files["public/logo.png"].base64, "base64").equals(PNG), "read_code returns binary as base64, byte-identical");
r = await m2.tool("read_code", { checkin: "preview" });
ok(r.v.public.files === 4 && !("public/logo.png" in r.v.files) && r.v.files["src/hello.html"] === "<h1>dynamic</h1>", "the full listing inlines code and only counts static files");
r = await m2.tool("release_change", {});
ok(!r.isError, "release the site");
r = await m2.tool("describe_object");
ok(r.v.public.files === 4 && r.v.public.bytes > 100 && r.v.public.first.includes("public/logo.png") && r.v.files.every((f: any) => f.path.startsWith("src/")), "describe_object lists code files and summarises static files");
r = await m2.tool("read_object", { kind: "fetch", path: "/docs/" });
ok(r.v.body === "<h1>docs</h1>" && r.v.read_only, "static files on live through read_object");
m2.close();

// perch run: a class with no fetch() still serves its files, and 404s the rest.
const bare = join(dir, "bare.perch");
const seed = mkdtempSync(join(tmpdir(), "perch-seed-"));
Bun.write(join(seed, "src/index.ts"), `import { DurableObject } from "cloudflare:workers";\nexport class Bare extends DurableObject {}\n`);
Bun.write(join(seed, "public/index.html"), "<h1>bare</h1>");
await Bun.sleep(50);
sh(["new", bare, "--class", "Bare", "--from", seed]);
const port3 = port + 2;
run = await serve(bare, port3);
res = await fetch(`http://127.0.0.1:${port3}/`);
ok(res.status === 200 && (await res.text()) === "<h1>bare</h1>", "perch run serves public/ from --from imports");
res = await fetch(`http://127.0.0.1:${port3}/nothing`);
ok(res.status === 404, "no fetch() and no file is a 404");
run.kill();

// Export: public/ becomes Workers Static Assets, bytes unchanged.
const out = join(dir, "site-export");
sh(["export", site, out]);
const wr = JSON.parse(readFileSync(join(out, "wrangler.jsonc"), "utf8").replace(/^\/\/.*\n/, ""));
ok(wr.assets?.directory === "./public", "export maps public/ to assets.directory");
ok(readFileSync(join(out, "public/logo.png")).equals(PNG) && readFileSync(join(out, "src/hello.html"), "utf8") === "<h1>dynamic</h1>", "export writes binary and text files unchanged");
ok(wr.rules?.[0]?.globs?.includes("**/*.css"), "export adds text-import rules for .css/.md/.svg");
const worker = readFileSync(join(out, "perch/worker.js"), "utf8");
ok(worker.includes('export { Site } from "../src/index.ts"') && !existsSync(join(out, "perch/migrations.js")) && !worker.includes("rpc"), "the exported Worker only re-exports the class and routes to it");

// ------------------------------------------------------------------ edits, stored tests, undo
const gate = join(dir, "gate.perch");
sh(["new", gate, "--class", "Todo", "--name", "todo"]);
const m3 = new Mcp(gate);
await m3.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
r = await m3.tool("propose_change", {
  message: "to-do with stored tests",
  files: { ...TODO, "test/todo.test.ts": src("test/todo.test.ts") },
});
ok(r.v.build.ok && r.v.tests.ok && r.v.tests.total === 8, "propose_change runs the stored tests (8 pass)");

// An edit that breaks behavior: caught by the tests, release refused.
r = await m3.tool("propose_change", {
  message: "oops: wrong status",
  edits: [{ path: "src/index.ts", old: "return Response.json(this.add(body.title), { status: 201 });", new: "return Response.json(this.add(body.title), { status: 200 });" }],
});
ok(r.v.build.ok && r.v.files_changed.includes("src/index.ts"), "an edit changes one line without resending the file");
ok(r.isError && !r.v.tests.ok && r.v.tests.failed === 1 && r.v.tests.results.find((t: any) => !t.ok).error.includes("expected 200 to be 201"), "the stored test catches the regression, with the assertion message");
r = await m3.tool("release_change", {});
ok(r.isError && r.text.includes("stored tests fail") && r.text.includes("adds and lists an item"), "release_change refuses while a test fails");
r = await m3.tool("propose_change", { message: "x", edits: [{ path: "src/index.ts", old: "this text is not in the file", new: "y" }] });
ok(r.isError && r.text.includes("was not found"), "an edit whose old text is missing is refused");
r = await m3.tool("propose_change", { message: "x", edits: [{ path: "src/index.ts", old: "this.ctx.storage", new: "y" }] });
ok(r.isError && /occurs \d+ times/.test(r.text), "an ambiguous edit is refused");
r = await m3.tool("propose_change", {
  message: "fix status",
  edits: [{ path: "src/index.ts", old: "{ status: 200 });", new: "{ status: 201 });" }],
});
ok(r.v.tests.ok, "fixing it with an edit makes the tests pass");
r = await m3.tool("release_change", { message: "to-do with stored tests" });
ok(!r.isError && r.v.released, "release goes through once tests pass");
ok(sh(["test", gate]).passed === 8, "perch test runs the stored tests from the CLI");
r = await m3.tool("query_data", { sql: "SELECT count(*) FROM todos" });
ok(r.v.rows[0][0] === 0, "tests ran on scratch copies: live has no rows");

// Two rows on live.
await m3.tool("call_object", { kind: "rpc", method: "add", args: ["first"] });
await m3.tool("call_object", { kind: "rpc", method: "add", args: ["second"] });

// Reads and writes are separate tools, and the read is enforced by the runtime.
r = await m3.tool("read_object", { kind: "rpc", method: "stats" });
ok(r.v.ok && r.v.result.total === 2 && r.v.read_only, "read_object calls a getter");
r = await m3.tool("read_object", { kind: "fetch", path: "/todos?done=0" });
ok(r.v.status === 200 && r.v.json.length === 2, "read_object GETs a route");
r = await m3.tool("read_object", { kind: "rpc", method: "add", args: ["sneaky"] });
ok(r.isError && r.v.error.includes("read-only") && r.v.error.includes("call_object"), "a SQL write during read_object is refused, with the tool to use");
r = await m3.tool("read_object", { kind: "rpc", method: "setRetention", args: [1] });
ok(r.isError && r.v.error.includes("read-only"), "a key-value write during read_object is refused");
r = await m3.tool("read_object", { kind: "rpc", method: "scheduleCleanup", args: [1] });
ok(r.isError && r.v.error.includes("read-only"), "an alarm change during read_object is refused");
r = await m3.tool("query_data", { sql: "SELECT count(*) FROM todos" });
ok(r.v.rows[0][0] === 2 && sh(["describe", gate]).kv_keys === 0, "nothing was written by the refused reads");
r = await m3.tool("read_object", { kind: "fetch", path: "/todos", http_method: "POST" });
ok(r.isError && r.text.includes("call_object"), "read_object refuses POST");
r = await m3.tool("call_object", { kind: "fetch", path: "/todos", http_method: "GET" });
ok(r.isError && r.text.includes("read_object"), "call_object refuses GET");
r = await m3.tool("call_object", { target: "preview", kind: "fetch", path: "/todos", http_method: "GET" });
ok(r.isError && r.text.includes("read_object"), "call_object refuses GET on the preview too");
r = await m3.tool("call_object", { kind: "fetch", path: "/todos", body: { title: "third" } });
ok(r.v.status === 201, "call_object defaults to POST and still writes");
m3.close();

// ------------------------------------------------------------------ bulk import of static files
const big = join(dir, "gallery.perch");
const photos = mkdtempSync(join(tmpdir(), "perch-photos-"));
const N = 3000;
for (let i = 0; i < N; i++) {
  const sub = join(photos, `set${i % 3}`);
  if (i < 3) await Bun.write(join(sub, ".keep"), "");
  await Bun.write(join(sub, `p${String(i).padStart(5, "0")}.jpg`), `photo ${i} ` + "x".repeat(900));
}
await Bun.write(join(photos, ".DS_Store"), "junk");
sh(["new", big, "--class", "Todo", "--name", "gallery", "--from", join(ROOT, "examples/todo")]);
const before3 = sh(["describe", big]).public.files;
let imp = sh(["import", big, photos, "--into", "public/img"]);
ok(imp.imported && imp.added === N && imp.public_files === before3 + N, `perch import streams ${N} files into public/img/ as one check-in`);
ok(sh(["describe", big]).checkins.total === 2, "the import is one check-in");
imp = sh(["import", big, photos, "--into", "public/img"]);
ok(!imp.imported && imp.unchanged === N && sh(["describe", big]).checkins.total === 2, "importing the same directory again changes nothing");
await Bun.write(join(photos, "set0/p00000.jpg"), "a new version of photo 0");
await Bun.write(join(photos, "set1/extra.jpg"), "one more");
(await import("node:fs")).rmSync(join(photos, "set2/p00002.jpg"));
imp = sh(["import", big, photos, "--into", "public/img", "--prune"]);
ok(imp.added === 1 && imp.replaced === 1 && imp.removed === 1 && imp.unchanged === N - 2, "a later import adds, replaces and (with --prune) removes only what changed");
ok(shFail(["import", big, photos, "--into", "src/"]).code !== 0, "import refuses to write outside public/");
const port4 = port + 3;
run = await serve(big, port4);
res = await fetch(`http://127.0.0.1:${port4}/img/set0/p00000.jpg`);
ok(res.status === 200 && res.headers.get("content-type") === "image/jpeg" && (await res.text()) === "a new version of photo 0", "an imported file is served, with its replaced contents");
ok((await fetch(`http://127.0.0.1:${port4}/img/set2/p00002.jpg`)).status === 404 && (await fetch(`http://127.0.0.1:${port4}/img/.DS_Store`)).status === 404, "pruned files and dotfiles are not served");
const t0 = performance.now();
for (let i = 3; i < 303; i++) await (await fetch(`http://127.0.0.1:${port4}/img/set${i % 3}/p${String(i).padStart(5, "0")}.jpg`)).arrayBuffer();
const perReq = (performance.now() - t0) / 300;
ok(perReq < 5, `static files are served from an in-memory index (${perReq.toFixed(2)} ms each)`);
res = await fetch(`http://127.0.0.1:${port4}/todos`, { method: "POST", body: JSON.stringify({ title: "code still runs" }), headers: { "content-type": "application/json" } });
ok(res.status === 201, "the class still runs beside thousands of static files");
// An import while the server runs: the new file is served without a restart.
await Bun.write(join(photos, "set1/late.jpg"), "added while running");
sh(["import", big, photos, "--into", "public/img"]);
res = await fetch(`http://127.0.0.1:${port4}/img/set1/late.jpg`);
ok(res.status === 200 && (await res.text()) === "added while running", "a running server picks up an import");
run.kill();
// The agent's route: the same import as an MCP tool, by directory path.
const m4 = new Mcp(big);
await m4.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
await Bun.write(join(photos, "set0/from-agent.jpg"), "via mcp");
r = await m4.tool("import_files", { dir: photos, into: "public/img/" });
ok(!r.isError && r.v.added === 1 && r.v.unchanged >= N - 1, "import_files imports a directory by path over MCP");
r = await m4.tool("propose_change", { message: "edit code beside the photos", edits: [{ path: "src/index.ts", old: '{ error: "title is required" }', new: '{ error: "a title is required" }' }] });
ok(r.v.build.ok && r.v.tests.ok, "code changes still build and pass tests with the photos in place");
r = await m4.tool("import_files", { dir: photos });
ok(r.isError && r.text.includes("unreleased preview"), "import is refused while a preview is unreleased");
r = await m4.tool("release_change", {});
ok(!r.isError && sh(["describe", big]).public.files === imp.public_files + 2, "a code release keeps every static file");
m4.close();
const exp = join(dir, "gallery-export");
const ex = sh(["export", big, exp]);
ok(ex.warnings.length === 0 && readFileSync(join(exp, "public/img/set0/p00000.jpg"), "utf8") === "a new version of photo 0", "export writes the imported files, with no warning under the Cloudflare limit");

// ------------------------------------------------------------------ a copy without the data
// The source has rows, a key-value entry, an alarm and several check-ins.
sh(["call", big, "add", '["a private row zq81"]']);
sh(["call", big, "setRetention", "[12345]"]);
const shared = join(dir, "shared.perch");
sh(["new", shared, "--like", big]);
let ds = sh(["describe", shared]);
ok(ds.tables.length === 0 && ds.kv_keys === 0 && !ds.next_alarm, "perch new --like makes a copy with no tables, rows, key-value entries or alarm");
ok(ds.public.files === sh(["describe", big]).public.files && ds.files.length === sh(["describe", big]).files.length, "the copy has the same code and static files");
ok(ds.checkins.total === 1, "the copy has one check-in: no history");
ok(!readFileSync(shared).toString("latin1").includes("zq81") && readFileSync(big).toString("latin1").includes("zq81"), "the source's rows are nowhere in the copy's bytes");
ok(sh(["test", shared]).passed === 8 && sh(["call", shared, "add", '["works"]']).result.title === "works", "the copy passes its stored tests and runs");
ds = sh(["describe", shared]);
ok(ds.tables.find((t: any) => t.name === "todos")?.rows === 1 && ds.next_alarm, "its code built the tables the first time it ran");

console.log(`\n${passed} checks passed (${dir})`);
process.exit(0);
