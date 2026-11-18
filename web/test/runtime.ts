// Cross-runtime check for the browser runtime core (run under bun):
//   native perch builds todo.perch -> the WebAssembly runtime opens it and serves
//   the same HTTP calls -> the saved file goes back to native perch, which must
//   see the same data, undo a browser-made change, and pass its stored tests.
//
//   bun test/runtime.ts        (after cargo build --release in perch/)

import init from "@sqlite.org/sqlite-wasm";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjRuntime, type Req } from "../src/runtime/objrun";

const ROOT = join(import.meta.dir, "../..");
const PERCH = process.env.PERCH ?? join(ROOT, "target/release/perch");
const dir = mkdtempSync(join(tmpdir(), "perch-web-"));
const file = join(dir, "todo.perch");

let n = 0;
function ok(cond: unknown, what: string) {
  if (!cond) {
    console.error(`FAIL ${what}`);
    process.exit(1);
  }
  n++;
  console.log(`ok   ${what}`);
}
function sh(args: string[]): any {
  const r = Bun.spawnSync([PERCH, ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`perch ${args.join(" ")}: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString());
}

sh(["new", file, "--class", "Todo", "--name", "todo", "--from", join(ROOT, "examples/todo")]);
// Native writes first, so the browser runtime opens a file with history, KV and an alarm.
sh(["call", file, "add", '["made by native perch"]']);
sh(["call", file, "setRetention", "[0]"]);

const sqlite3 = await init({ print: () => {}, printErr: () => {} });
const bootstrap = readFileSync(join(ROOT, "js/bootstrap.js"), "utf8");
const logs: string[] = [];
const toUrl = (code: string) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const rt = await ObjRuntime.open(new Uint8Array(readFileSync(file)), { sqlite3, bootstrap, toUrl, onLog: (l) => logs.push(l.message) });
ok(!rt.loadError, `the object's TypeScript loads and its constructor runs${rt.loadError ? ": " + rt.loadError : ""}`);

const info = rt.info();
ok(info.name === "todo" && info.class === "Todo" && info.tables.find((t: any) => t.name === "todos")?.rows === 1, "info shows the object native perch built");
ok(info.public.includes("public/index.html") && info.files.includes("src/stats.html"), "files and static files are listed");

const base = "http://todo.perch.local";
const dec = new TextDecoder(), enc = new TextEncoder();
const call = async (method: string, path: string, body?: unknown, headers: [string, string][] = []) => {
  const req: Req = { method, url: base + path, headers: body === undefined ? headers : [["content-type", "application/json"], ...headers], body: body === undefined ? null : enc.encode(JSON.stringify(body)) };
  const res = await rt.fetch(req);
  const text = dec.decode(res.body);
  let json: any;
  try { json = JSON.parse(text); } catch {}
  return { ...res, text, json, header: (k: string) => res.headers.find(([h]) => h === k)?.[1] };
};
const rpc = async (m: string, ...args: unknown[]) => (await call("POST", `/.perch/rpc/${m}`, args)).json;

// Static files, with the Cloudflare rules.
let r = await call("GET", "/");
ok(r.status === 200 && r.asset === "public/index.html" && r.text.includes("<title>To-do</title>"), "GET / serves public/index.html");
r = await call("GET", "/index.html");
ok(r.status === 307 && r.header("location") === "/", "/index.html redirects to /");
r = await call("GET", "/logo.png");
ok(r.status === 200 && r.header("content-type") === "image/png" && r.body.length === 100, "binary static file is byte-exact");
r = await call("GET", "/logo.png", undefined, [["if-none-match", r.header("etag")!]]);
ok(r.status === 304, "ETag revalidation gets a 304");

// The class: fetch, RPC, SQL, KV, an imported template.
r = await call("GET", "/todos");
ok(r.status === 200 && r.json.length === 1 && r.json[0].title === "made by native perch", "GET /todos reads the row native perch wrote");
r = await call("POST", "/todos", { title: "made in the browser runtime" });
const made = r.json;
ok(r.status === 201 && /^[0-9a-f-]{36}$/.test(made.id) && made.id[14] === "7", "POST /todos writes a UUIDv7 row");
r = await call("POST", "/todos", {});
ok(r.status === 400, "validation still returns 400");
r = await call("PATCH", `/todos/${made.id}`, { done: true });
ok(r.json.done === 1, "PATCH marks done");
let stats = (await rpc("stats")).result;
ok(stats.total === 2 && stats.done === 1, "RPC over /.perch/rpc returns the right data");
ok((await call("POST", "/.perch/rpc/constructor", [])).status === 500, "constructor is not RPC");
r = await call("GET", "/stats");
ok(r.status === 200 && r.text.includes("<td>Total</td><td>2</td>"), "a page renders from an imported .html template");

// The alarm: retention is 0 (set by native), so the done item is removed.
await rpc("scheduleCleanup", 0);
ok(await rt.tickAlarm(), "the due alarm fires");
stats = (await rpc("stats")).result;
ok(stats.done === 0 && stats.lastCleanup, "the alarm's deletes and its KV write are in the data");
ok(rt.info().nextAlarm! > Date.now() + 60_000, "the alarm rescheduled itself");
ok(rt.dirty, "the runtime knows there are unsaved changes");

// Save, and hand the file back to native perch.
const out = join(dir, "from-browser.perch");
writeFileSync(out, rt.export());
ok(!rt.dirty, "export clears the unsaved flag");
const d = sh(["describe", out]);
ok(d.tables.find((t: any) => t.name === "todos").rows === 1 && d.next_alarm, "native perch opens the saved file and sees the rows and the alarm");
const nstats = sh(["call", out, "stats"]).result;
ok(nstats.total === 1 && nstats.lastCleanup === stats.lastCleanup, "native perch reads the KV value the browser runtime wrote");
const changes = sh(["changes", out, "--limit", "50"]).changes;
const browserAdds = changes.filter((c: any) => c.event === "rpc" && c.tables.todos?.inserts === 1);
ok(changes.some((c: any) => c.event === "alarm" && c.tables.todos?.deletes === 1) && browserAdds.length >= 1, "changesets recorded in the browser are readable by native perch");
const before = sh(["call", out, "stats"]).result.total;
sh(["undo", out, String(changes[0].id)]);
ok(sh(["call", out, "stats"]).result.total !== before || changes[0].tables._perch_kv, "native perch can undo a change made in the browser runtime");
const t = sh(["test", out]);
ok(t.ok && t.passed === 8, "the saved file passes its stored tests under native perch");
rt.close();

// The sandbox holds in the browser runtime too: a second object whose class
// runs whatever SQL it is handed.
const seed = join(dir, "probe");
await Bun.write(join(seed, "src/index.ts"), `import { DurableObject } from "cloudflare:workers";
import { helper } from "./lib/helper";
export class Probe extends DurableObject {
  run(q: string) { try { this.ctx.storage.sql.exec(q); return "allowed"; } catch (e: any) { return String(e.message || e); } }
  ok() { return helper(this.ctx.storage.sql.exec("SELECT count(*) AS n FROM notes").one().n as number); }
}
`);
await Bun.write(join(seed, "src/lib/helper.ts"), `export const helper = (n: number): string => "notes:" + n;\n`);
await Bun.write(join(seed, "migrations/0001.sql"), "CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);");
const probeFile = join(dir, "probe.perch");
sh(["new", probeFile, "--class", "Probe", "--from", seed]);
const p = await ObjRuntime.open(new Uint8Array(readFileSync(probeFile)), { sqlite3, bootstrap, toUrl });
ok(!p.loadError && (await p.rpc("ok", []) as any).result === "notes:0", "a second object loads, with a nested relative import");
for (const q of ["SELECT * FROM _perch_meta", "UPDATE _perch_checkins SET message = 'x'", "DELETE FROM _perch_kv", "DROP TABLE notes", "CREATE TABLE sneaky (id TEXT PRIMARY KEY)", "BEGIN", "ATTACH DATABASE ':memory:' AS x", "PRAGMA journal_mode = DELETE"]) {
  const res = (await p.rpc("run", [q]) as any).result as string;
  ok(res !== "allowed" && /not authorized|prohibited|SQLITE_AUTH/i.test(res), `object code refused in the browser runtime: ${q}`);
}
ok((await p.rpc("run", ["INSERT INTO notes VALUES ('a', 'b')"]) as any).result === "allowed", "ordinary writes to data tables are allowed");

console.log(`\n${n} checks passed (${dir})`);
process.exit(0);
