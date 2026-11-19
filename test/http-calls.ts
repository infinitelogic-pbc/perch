// The same HTTP calls against any host serving a freshly created to-do object:
// `perch run` locally, or the `perch export` deploy on Cloudflare.
//
//   bun test/http-calls.ts http://127.0.0.1:8787
//   bun test/http-calls.ts https://perch-todo-demo.<account>.workers.dev

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
const stats = async () => (await (await fetch(`${base}/api/stats`)).json()) as any;
const json = { "content-type": "application/json" };

const before = await stats();
ok(typeof before.total === "number", `GET /api/stats (${before.total} items to start)`);

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
r = await fetch(`${base}/todos`, { method: "POST", headers: json, body: JSON.stringify({ title: "second" }) });
const added = (await r.json()) as any;
const mid = await stats();
ok(mid.total === before.total + 2 && mid.done >= 1, "stats sees both");
r = await fetch(`${base}/.perch/rpc/stats`, { method: "POST", body: "[]" });
ok(r.status === 404, "methods are not reachable over HTTP");

// Alarm: drop done items now.
await fetch(`${base}/api/cleanup`, { method: "POST", headers: json, body: JSON.stringify({ retentionMs: 0, inMs: 500 }) });
let after: any;
for (let i = 0; i < 30; i++) {
  await Bun.sleep(500);
  after = await stats();
  if (after.lastCleanup && after.done === 0) break;
}
ok(after.done === 0 && after.lastCleanup, "alarm fired and removed the done items");
await fetch(`${base}/api/cleanup`, { method: "POST", headers: json, body: JSON.stringify({ retentionMs: 24 * 60 * 60 * 1000 }) });

r = await fetch(`${base}/todos/${added.id}`, { method: "DELETE" });
ok(r.status === 204, "DELETE /todos/:id");

// Static files (public/) and a dynamic page from an imported template.
r = await fetch(`${base}/`);
ok(r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/html") && (await r.text()).includes("<title>To-do</title>"), "GET / serves public/index.html");
r = await fetch(`${base}/index.html`, { redirect: "manual" });
ok(r.status === 307 && new URL(r.headers.get("location")!, base).pathname === "/", "/index.html redirects to /");
r = await fetch(`${base}/app.css`);
ok(r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/css"), "GET /app.css is text/css");
r = await fetch(`${base}/logo.png`);
const png = new Uint8Array(await r.arrayBuffer());
ok(r.status === 200 && r.headers.get("content-type") === "image/png" && png[1] === 0x50 && png[2] === 0x4e && png.length === 100, "GET /logo.png returns the PNG bytes");
const etag = r.headers.get("etag");
r = await fetch(`${base}/logo.png`, { headers: { "if-none-match": etag! } });
ok(etag && r.status === 304, "revalidating with the ETag gets a 304");
r = await fetch(`${base}/stats`);
const statsHtml = await r.text();
ok(r.status === 200 && statsHtml.includes("<td>Total</td>") && !statsHtml.includes("{{"), "GET /stats renders the imported template");
console.log(`\n${n} calls passed against ${base}`);
