// End-to-end check of the first deliverable: build the to-do object entirely
// through the MCP tools, then serve it, fire its alarm, carry the file to
// another directory, undo a bad release, and confirm the sandbox holds.
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

// ------------------------------------------------------------------ build over MCP
sh(["new", file, "--class", "Todo"]);
const mcp = new Mcp(file);
const init = await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
ok(init.result.instructions.includes("propose_change"), "initialize returns the agent guide");
const list = await mcp.rpc("tools/list");
const names = list.result.tools.map((t: any) => t.name);
ok(names.length === 13, `thirteen tools (${names.join(", ")})`);
ok(list.result.tools.every((t: any) => t.title && t.annotations), "every tool has a title and annotations");
const ann = Object.fromEntries(list.result.tools.map((t: any) => [t.name, t.annotations]));
ok(list.result.tools.every((t: any) => (t.annotations.readOnlyHint === true) !== (t.annotations.destructiveHint === true)), "every tool is exactly one of readOnlyHint or destructiveHint");
const READS = ["describe_object", "read_code", "list_checkins", "query_data", "read_object", "run_tests", "list_changes"];
ok(names.every((n: string) => READS.includes(n) === (ann[n].readOnlyHint === true)) && names.every((n: string) => n.length <= 64), "the read-only set is the seven read tools; names are within 64 characters");
const props = (n: string) => list.result.tools.find((t: any) => t.name === n).inputSchema.properties;
ok(!props("call_object").http_method.enum.includes("GET") && !props("test_call").http_method.enum.includes("GET") && props("read_object").http_method.enum.join() === "GET,HEAD", "no tool accepts both safe and unsafe HTTP methods");

let r = await mcp.tool("propose_change", {
  message: "to-do API with nightly cleanup",
  files: { "src/index.ts": src("src/index.ts"), "src/uuid.ts": src("src/uuid.ts"), "src/stats.html": src("src/stats.html") },
  migrations: [{ name: "0001_todos", sql: src("migrations/0001_todos.sql") }],
});
ok(!r.isError && r.v.build.ok, `propose_change builds on the preview (${r.v.checkin?.slice(0, 12)})`);
ok(r.v.schema.todos, "preview has the todos table");

r = await mcp.tool("test_call", { kind: "fetch", http_method: "POST", path: "/todos", body: { title: "buy milk" } });
ok(r.v.ok && r.v.status === 201 && r.v.json.title === "buy milk", "test_call POST /todos on preview");
ok(r.v.changes.todos?.inserts === 1, "test_call reports the row it inserted");
r = await mcp.tool("test_call", { kind: "rpc", method: "stats" });
ok(r.v.result.total === 1, "test_call rpc stats on preview");
r = await mcp.tool("query_data", { sql: "SELECT count(*) AS n FROM todos" });
ok(r.isError && r.text.includes("no such table"), "live is untouched: the migration only ran on the preview");
r = await mcp.tool("query_data", { sql: "SELECT count(*) AS n FROM todos", target: "preview" });
ok(r.v.rows[0][0] === 1, "query_data can read the preview");
r = await mcp.tool("describe_object", { target: "preview" });
ok(r.v.target === "preview" && r.v.next_alarm && r.v.tables.some((t: any) => t.name === "todos" && t.rows === 1), "describe_object can describe the preview, alarm included");
r = await mcp.tool("test_call", { kind: "alarm" });
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
  "DROP TABLE todos",
  "CREATE TABLE sneaky (id TEXT PRIMARY KEY)",
  "BEGIN",
  "ATTACH DATABASE '/tmp/x.db' AS x",
  "PRAGMA journal_mode = DELETE",
]) {
  r = await mcp.tool("test_call", { kind: "rpc", method: "probe", args: [q] });
  ok(r.v.result !== "allowed" && /not authorized|prohibited/i.test(r.v.result), `object code refused: ${q}`);
}
r = await mcp.tool("query_data", { sql: "SELECT * FROM _perch_checkins" });
ok(r.isError, "query_data refuses reserved tables");
r = await mcp.tool("query_data", { sql: "DELETE FROM todos", target: "preview" });
ok(r.isError && /not authorized|readonly/i.test(r.text), "query_data refuses writes");
r = await mcp.tool("propose_change", { message: "bad migration", migrations: [{ name: "x", sql: "DELETE FROM _perch_checkins" }] });
ok(r.isError, "a migration cannot touch reserved tables");
r = await mcp.tool("propose_change", { message: "no pk", migrations: [{ name: "x", sql: "CREATE TABLE t (a TEXT)" }] });
ok(r.isError && r.text.includes("PRIMARY KEY"), "data tables need a primary key");
r = await mcp.tool("propose_change", { message: "autoinc", migrations: [{ name: "x", sql: "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)" }] });
ok(r.isError && r.text.includes("AUTOINCREMENT"), "AUTOINCREMENT is refused");

// Discard the probe: start over from live with the clean code.
r = await mcp.tool("propose_change", {
  restart: true,
  message: "to-do API with nightly cleanup",
  files: { "src/index.ts": src("src/index.ts"), "src/uuid.ts": src("src/uuid.ts"), "src/stats.html": src("src/stats.html") },
  migrations: [{ name: "0001_todos", sql: src("migrations/0001_todos.sql") }],
});
ok(r.v.build.ok && !r.v.stacked_on_previous_preview, "restart starts from live");
r = await mcp.tool("release_change", {});
ok(!r.isError && r.v.released, `release_change moves live (${r.v.released?.slice(0, 12)})`);
const good = r.v.released as string;
r = await mcp.tool("describe_object");
ok(r.v.live_checkin.id === good && r.v.tables.some((t: any) => t.name === "todos") && !r.v.preview.exists, "describe_object shows the release");

r = await mcp.tool("call_object", { kind: "rpc", method: "add", args: ["write tests"] });
ok(r.v.ok && r.v.result.title === "write tests", "call_object rpc on live");
ok(sh(["describe", file]).next_alarm, "first live event ran the constructor, which scheduled the nightly alarm");
r = await mcp.tool("list_checkins", { diffs: true });
ok(r.v.checkins[0].live && r.v.checkins[0].migrations.length === 1 && r.v.checkins[0].diff.includes("+import { uuidv7 }"), "list_checkins shows diff and migration");

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
res = await fetch(`${base}/.perch/rpc/stats`, { method: "POST", body: "[]" });
let stats = (await res.json()).result;
ok(stats.total === 2 && stats.done === 1, "RPC over HTTP returns the right data");
res = await fetch(`${base}/.perch/rpc/constructor`, { method: "POST", body: "[]" });
ok(res.status === 500, "non-public methods are not RPC");

await fetch(`${base}/.perch/rpc/setRetention`, { method: "POST", body: "[0]" });
await fetch(`${base}/.perch/rpc/scheduleCleanup`, { method: "POST", body: "[300]" });
await Bun.sleep(1200);
stats = (await (await fetch(`${base}/.perch/rpc/stats`, { method: "POST", body: "[]" })).json()).result;
ok(stats.total === 1 && stats.done === 0 && stats.lastCleanup, "alarm fired on schedule and its writes show up in the data");
const d = sh(["describe", file]);
ok(d.next_alarm && d.next_alarm.at_ms > Date.now() + 60_000, "alarm rescheduled itself for midnight");

// ------------------------------------------------------------------ bad release + rollback while running
r = await mcp.tool("propose_change", {
  message: "oops: break listing",
  files: { "src/index.ts": src("src/index.ts").replace('if (request.method === "GET" && !id) {', 'if (request.method === "GET" && !id) {\n      throw new Error("listing broke");') },
});
ok(r.v.build.ok, "a broken handler still builds");
r = await mcp.tool("release_change", {});
const bad = r.v.released;
res = await fetch(`${base}/todos`);
ok(res.status === 500 && (await res.text()).includes("listing broke"), "running server picked up the bad release");
r = await mcp.tool("rollback_code", { checkin: good.slice(0, 10) });
ok(!r.isError && r.v.live === good, "rollback_code moves live back");
res = await fetch(`${base}/todos`);
ok(res.status === 200 && (await res.json()).length === 1, "running server serves the rolled-back code");

// A rollback across a breaking migration is refused.
r = await mcp.tool("propose_change", {
  message: "rename title to text",
  files: { "src/index.ts": src("src/index.ts").replaceAll("title", "text") },
  migrations: [{ name: "0002_rename", sql: "ALTER TABLE todos RENAME COLUMN title TO text" }],
});
ok(r.v.build.ok, "propose a breaking schema change");
r = await mcp.tool("release_change", { message: "rename title to text" });
ok(!r.isError, "release the breaking change");
r = await mcp.tool("rollback_code", { checkin: good });
ok(r.isError && r.text.includes("todos.title no longer exists"), "rollback refused when old code no longer fits the schema");
r = await mcp.tool("rollback_code", { checkin: bad });
ok(r.isError, "and for the bad release too");
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
ok(listed.length === 1 && listed[0].text === "write tests", "copied file serves the same code and data");
const d2 = sh(["describe", file2]);
ok(d2.live_checkin.id === sh(["describe", file]).live_checkin.id, "same live check-in after the copy");
run.kill();

const changes = sh(["checkins", file, "--limit", "100"]);
ok(changes.total === 4, `history kept (${changes.total} check-ins)`);

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
    ? m2.tool("test_call", { kind: "fetch", path, ...extra })
    : m2.tool("read_object", { kind: "fetch", path, target: "preview", ...extra });
r = await get("/");
ok(r.v.status === 200 && r.v.body === "<h1>home</h1>" && r.v.asset === "public/index.html", "/ serves public/index.html without waking the broken object");
ok(Object.keys(r.v.changes).length === 0 && r.v.logs.length === 0, "a static file runs no event (no changes, no logs)");
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
ok(r.v.files["public/logo.png"].binary && r.v.files["public/index.html"] === "<h1>home</h1>", "full listing stubs binary, inlines text");
r = await m2.tool("release_change", {});
ok(!r.isError, "release the site");
r = await m2.tool("describe_object");
ok(r.v.public.length === 4 && r.v.files.every((f: any) => f.path.startsWith("src/")), "describe_object lists static files separately");
r = await m2.tool("list_checkins", { diffs: true });
ok(r.v.checkins[0].diff.includes("Binary file public/logo.png differs"), "diffs mark binary files");
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

// ------------------------------------------------------------------ edits, stored tests, undo
const gate = join(dir, "gate.perch");
sh(["new", gate, "--class", "Todo", "--name", "todo"]);
const m3 = new Mcp(gate);
await m3.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
r = await m3.tool("propose_change", {
  message: "to-do with stored tests",
  files: {
    "src/index.ts": src("src/index.ts"), "src/uuid.ts": src("src/uuid.ts"), "src/stats.html": src("src/stats.html"),
    "test/todo.test.ts": src("test/todo.test.ts"),
  },
  migrations: [{ name: "0001_todos", sql: src("migrations/0001_todos.sql") }],
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
r = await m3.tool("run_tests", { target: "live" });
ok(r.v.ok && r.v.passed === 8 && r.v.target === "live", "run_tests on live");
r = await m3.tool("query_data", { sql: "SELECT count(*) FROM todos" });
ok(r.v.rows[0][0] === 0, "tests ran on scratch copies: live has no rows");

// Data undo.
await m3.tool("call_object", { kind: "rpc", method: "add", args: ["keep me"] });
await m3.tool("call_object", { kind: "rpc", method: "add", args: ["agent mistake"] });
await m3.tool("call_object", { kind: "rpc", method: "setRetention", args: [5] });
r = await m3.tool("list_changes", {});
const ch = r.v.changes;
ok(ch.length >= 3 && ch[0].event === "rpc" && ch[0].tables._perch_kv && ch[1].tables.todos.inserts === 1 && ch.every((c: any) => c.undoable), "list_changes shows events with rows per table");
const firstAdd = ch[2].id;
r = await m3.tool("undo_changes", { back_to: ch[1].id });
ok(!r.isError && r.v.undone.length === 2 && r.v.tables.todos.deletes === 1, "undo_changes reverses the two newest changes");
r = await m3.tool("query_data", { sql: "SELECT title FROM todos" });
ok(r.v.rows.length === 1 && r.v.rows[0][0] === "keep me", "the mistaken row is gone, the earlier one stays");
const redo = (await m3.tool("list_changes", {})).v.changes[0];
ok(redo.event === "undo", "the undo is recorded as a change");
r = await m3.tool("undo_changes", { back_to: redo.id });
r = await m3.tool("query_data", { sql: "SELECT count(*) FROM todos" });
ok(r.v.rows[0][0] === 2, "undoing the undo brings the row back");
r = await m3.tool("call_object", { kind: "rpc", method: "stats" });
ok(r.v.result.total === 2, "the live object sees the restored data");
r = await m3.tool("propose_change", { message: "add notes", migrations: [{ name: "0002_note", sql: "ALTER TABLE todos ADD COLUMN note TEXT" }] });
r = await m3.tool("release_change", {});
ok(!r.isError, "release a migration");
r = await m3.tool("undo_changes", { back_to: firstAdd });
ok(r.isError && r.text.includes("migration"), "undo is refused across a migration");

// Reads and writes are separate tools, and the read is enforced by the runtime.
const before = (await m3.tool("list_changes", {})).v.total;
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
ok(r.v.rows[0][0] === 2 && (await m3.tool("list_changes", {})).v.total === before, "nothing was written or recorded by the refused reads");
r = await m3.tool("read_object", { kind: "fetch", path: "/todos", http_method: "POST" });
ok(r.isError && r.text.includes("call_object"), "read_object refuses POST");
r = await m3.tool("call_object", { kind: "fetch", path: "/todos", http_method: "GET" });
ok(r.isError && r.text.includes("read_object"), "call_object refuses GET");
r = await m3.tool("test_call", { kind: "fetch", path: "/todos", http_method: "GET" });
ok(r.isError && r.text.includes("read_object"), "test_call refuses GET");
r = await m3.tool("call_object", { kind: "fetch", path: "/todos", body: { title: "third" } });
ok(r.v.status === 201, "call_object defaults to POST and still writes");
r = await m3.tool("list_checkins", {});
ok(r.v.checkins[0].diff === undefined, "list_checkins leaves diffs out unless asked");
m3.close();

ok(sh(["test", gate]).passed === 8, "perch test runs the stored tests from the CLI");

console.log(`\n${passed} checks passed (${dir})`);
process.exit(0);
