// The same HTTP calls against any host serving a freshly created to-do object:
// `pdo run` locally, or the `pdo export` deploy on Cloudflare.
//
//   bun test/http-calls.ts http://127.0.0.1:8787
//   bun test/http-calls.ts https://pdo-todo-demo.<account>.workers.dev

const base = process.argv[2];
if (!base) throw new Error("usage: bun test/http-calls.ts <base url>");

let n = 0;
function ok(cond: unknown, what: string) {
  if (!cond) {
    console.error(`FAIL ${what}`);
    process.exit(1);
  }
  n++;
  console.log(`ok   ${what}`);
}
const rpc = async (m: string, ...args: unknown[]) => {
  const r = await fetch(`${base}/.pdo/rpc/${m}`, { method: "POST", body: JSON.stringify(args) });
  return { status: r.status, body: (await r.json()) as any };
};
const json = { "content-type": "application/json" };

const before = (await rpc("stats")).body.result;
ok(typeof before.total === "number", `RPC stats (${before.total} items to start)`);

let r = await fetch(`${base}/todos`, { method: "POST", headers: json, body: JSON.stringify({ title: "conformance" }) });
const t = await r.json();
ok(r.status === 201 && t.title === "conformance" && /^[0-9a-f-]{36}$/.test(t.id) && t.id[14] === "7", "POST /todos returns a UUIDv7 row");
r = await fetch(`${base}/todos`, { method: "POST", headers: json, body: JSON.stringify({}) });
ok(r.status === 400, "POST without a title is a 400");
r = await fetch(`${base}/todos/${t.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ done: true }) });
const patched = await r.json();
ok(patched.done === 1 && typeof patched.done_at === "number", "PATCH marks done");
r = await fetch(`${base}/todos?done=1`);
ok((await r.json()).some((x: any) => x.id === t.id), "GET ?done=1 lists it");
r = await fetch(`${base}/nope`);
ok(r.status === 404, "unknown path is a 404");
const added = (await rpc("add", "via rpc")).body.result;
ok(added.title === "via rpc", "RPC add");
const mid = (await rpc("stats")).body.result;
ok(mid.total === before.total + 2 && mid.done >= 1, "RPC stats sees both");
ok((await rpc("constructor")).status === 500, "constructor is not RPC");

// Alarm: drop done items now.
await rpc("setRetention", 0);
await rpc("scheduleCleanup", 500);
let after: any;
for (let i = 0; i < 30; i++) {
  await Bun.sleep(500);
  after = (await rpc("stats")).body.result;
  if (after.lastCleanup && after.done === 0) break;
}
ok(after.done === 0 && after.lastCleanup, "alarm fired and removed the done items");
await rpc("setRetention", 24 * 60 * 60 * 1000);

r = await fetch(`${base}/todos/${added.id}`, { method: "DELETE" });
ok(r.status === 204, "DELETE /todos/:id");
console.log(`\n${n} calls passed against ${base}`);
