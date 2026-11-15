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
const PDO = process.env.PDO ?? join(ROOT, "target/debug/pdo");
const dir = mkdtempSync(join(tmpdir(), "pdo-e2e-"));
const file = join(dir, "todo.obj");

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
  const r = Bun.spawnSync([PDO, ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`pdo ${args.join(" ")}: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString());
}

class Mcp {
  proc: ChildProcess;
  next = 1;
  waiting = new Map<number, (v: any) => void>();
  constructor(path: string) {
    this.proc = spawn(PDO, ["mcp", path], { stdio: ["pipe", "pipe", "inherit"] });
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
ok(names.length === 9, `nine tools (${names.join(", ")})`);
ok(list.result.tools.every((t: any) => t.title && t.annotations), "every tool has a title and annotations");
const ann = Object.fromEntries(list.result.tools.map((t: any) => [t.name, t.annotations]));
ok(ann.describe_object.readOnlyHint && ann.query_data.readOnlyHint && ann.release_change.destructiveHint && ann.call_object.destructiveHint, "annotations match the plan");

let r = await mcp.tool("propose_change", {
  message: "to-do API with nightly cleanup",
  files: { "src/index.ts": src("src/index.ts"), "src/uuid.ts": src("src/uuid.ts") },
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
  "SELECT * FROM _obj_meta",
  "UPDATE _obj_checkins SET message = 'x'",
  "DELETE FROM _obj_kv",
  "DROP TABLE todos",
  "CREATE TABLE sneaky (id TEXT PRIMARY KEY)",
  "BEGIN",
  "ATTACH DATABASE '/tmp/x.db' AS x",
  "PRAGMA journal_mode = DELETE",
]) {
  r = await mcp.tool("test_call", { kind: "rpc", method: "probe", args: [q] });
  ok(r.v.result !== "allowed" && /not authorized|prohibited/i.test(r.v.result), `object code refused: ${q}`);
}
r = await mcp.tool("query_data", { sql: "SELECT * FROM _obj_checkins" });
ok(r.isError, "query_data refuses reserved tables");
r = await mcp.tool("query_data", { sql: "DELETE FROM todos", target: "preview" });
ok(r.isError && /not authorized|readonly/i.test(r.text), "query_data refuses writes");
r = await mcp.tool("propose_change", { message: "bad migration", migrations: [{ name: "x", sql: "DELETE FROM _obj_checkins" }] });
ok(r.isError, "a migration cannot touch reserved tables");
r = await mcp.tool("propose_change", { message: "no pk", migrations: [{ name: "x", sql: "CREATE TABLE t (a TEXT)" }] });
ok(r.isError && r.text.includes("PRIMARY KEY"), "data tables need a primary key");
r = await mcp.tool("propose_change", { message: "autoinc", migrations: [{ name: "x", sql: "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)" }] });
ok(r.isError && r.text.includes("AUTOINCREMENT"), "AUTOINCREMENT is refused");

// Discard the probe: start over from live with the clean code.
r = await mcp.tool("propose_change", {
  restart: true,
  message: "to-do API with nightly cleanup",
  files: { "src/index.ts": src("src/index.ts"), "src/uuid.ts": src("src/uuid.ts") },
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
r = await mcp.tool("list_checkins");
ok(r.v.checkins[0].live && r.v.checkins[0].migrations.length === 1 && r.v.checkins[0].diff.includes("+import { uuidv7 }"), "list_checkins shows diff and migration");

// ------------------------------------------------------------------ pdo run: HTTP + RPC + alarm
async function serve(path: string, port: number): Promise<ChildProcess> {
  const p = spawn(PDO, ["run", path, "--port", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
  p.stderr!.on("data", (d) => process.env.VERBOSE && process.stderr.write(d));
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/todos`); return p; } catch { await Bun.sleep(50); }
  }
  throw new Error("pdo run did not start");
}
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let run = await serve(file, port);
let res = await fetch(`${base}/todos`, { method: "POST", body: JSON.stringify({ title: "ship pdo" }), headers: { "content-type": "application/json" } });
const shipped = await res.json();
ok(res.status === 201 && shipped.title === "ship pdo", "HTTP POST /todos");
res = await fetch(`${base}/todos/${shipped.id}`, { method: "PATCH", body: JSON.stringify({ done: true }) });
ok((await res.json()).done === 1, "HTTP PATCH marks done");
res = await fetch(`${base}/todos?done=0`);
const open = await res.json();
ok(open.length === 1 && open[0].title === "write tests", "HTTP GET with query filter");
res = await fetch(`${base}/.pdo/rpc/stats`, { method: "POST", body: "[]" });
let stats = (await res.json()).result;
ok(stats.total === 2 && stats.done === 1, "RPC over HTTP returns the right data");
res = await fetch(`${base}/.pdo/rpc/constructor`, { method: "POST", body: "[]" });
ok(res.status === 500, "non-public methods are not RPC");

await fetch(`${base}/.pdo/rpc/setRetention`, { method: "POST", body: "[0]" });
await fetch(`${base}/.pdo/rpc/scheduleCleanup`, { method: "POST", body: "[300]" });
await Bun.sleep(1200);
stats = (await (await fetch(`${base}/.pdo/rpc/stats`, { method: "POST", body: "[]" })).json()).result;
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
const dir2 = mkdtempSync(join(tmpdir(), "pdo-carry-"));
const file2 = join(dir2, "todo.obj");
// Only the .obj file travels: every commit checkpoints the WAL into it.
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

console.log(`\n${passed} checks passed (${dir})`);
process.exit(0);
