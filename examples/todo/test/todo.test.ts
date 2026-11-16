import { test, expect } from "pdo:test";

const DAY = 24 * 60 * 60 * 1000;

test("adds and lists an item", async (obj) => {
  const res = await obj.fetch("/todos", { body: { title: "buy milk" } });
  expect(res.status).toBe(201);
  const item = await res.json();
  expect(item.title).toBe("buy milk");
  expect(item.id).toMatch(/^[0-9a-f-]{36}$/);

  const list = await (await obj.fetch("/todos")).json();
  expect(list).toHaveLength(1);
});

test("rejects a missing title", async (obj) => {
  const res = await obj.fetch("/todos", { body: {} });
  expect(res.status).toBe(400);
  expect(obj.sql("SELECT count(*) AS n FROM todos")[0].n).toBe(0);
});

test("marks done and filters", async (obj) => {
  const a = await obj.rpc("add", "one");
  await obj.rpc("add", "two");
  const res = await obj.fetch(`/todos/${a.id}`, { method: "PATCH", body: { done: true } });
  expect((await res.json()).done).toBe(1);
  expect(await (await obj.fetch("/todos?done=1")).json()).toHaveLength(1);
  expect(await (await obj.fetch("/todos?done=0")).json()).toHaveLength(1);
  const stats = await obj.rpc("stats");
  expect(stats.total).toBe(2);
  expect(stats.done).toBe(1);
});

test("unknown ids are 404", async (obj) => {
  expect((await obj.fetch("/todos/nope", { method: "PATCH", body: { done: true } })).status).toBe(404);
  expect((await obj.fetch("/todos/nope", { method: "DELETE" })).status).toBe(404);
});

test("the constructor schedules the nightly cleanup", async (obj) => {
  const at = await obj.storage.getAlarm();
  expect(at).toBeGreaterThan(obj.clock.now());
  expect(at - obj.clock.now()).toBeLessThan(DAY + 1);
});

test("cleanup removes items done for over a day, and keeps the rest", async (obj) => {
  const old = await obj.rpc("add", "old and done");
  await obj.rpc("setDone", old.id, true);
  obj.clock.advance(2 * DAY);
  const fresh = await obj.rpc("add", "done just now");
  await obj.rpc("setDone", fresh.id, true);
  await obj.rpc("add", "still open");

  await obj.alarm();

  const titles = obj.sql("SELECT title FROM todos ORDER BY created_at").map((r) => r.title);
  expect(titles).toEqual(["done just now", "still open"]);
  expect((await obj.rpc("stats")).lastCleanup).toBeGreaterThan(0);
  expect(await obj.storage.getAlarm()).toBeGreaterThan(obj.clock.now());
});

test("key-value storage keeps rich values", async (obj) => {
  const value = {
    when: new Date(5),
    tags: new Set(["a", "b"]),
    by: new Map<string, unknown>([["k", 12345678901234567890n]]),
    bytes: new Uint8Array([1, 2, 255]),
    negZero: -0,
    missing: undefined,
    nan: NaN,
    $pdo: "a key that looks like a tag",
    nested: [{ deep: [null, true, "x"] }],
  };
  await obj.storage.put("rich", value);
  const got: any = await obj.storage.get("rich");
  expect(got.when instanceof Date && got.when.getTime()).toBe(5);
  expect([...got.tags]).toEqual(["a", "b"]);
  expect(got.by.get("k")).toBe(12345678901234567890n);
  expect(got.bytes instanceof Uint8Array && [...got.bytes]).toEqual([1, 2, 255]);
  expect(Object.is(got.negZero, -0)).toBe(true);
  expect("missing" in got && got.missing).toBeUndefined();
  expect(Number.isNaN(got.nan)).toBe(true);
  expect(got.$pdo).toBe("a key that looks like a tag");
  expect(got.nested).toEqual([{ deep: [null, true, "x"] }]);
  // Stored as plain JSON text, readable by any runtime.
  const cyc: any = {};
  cyc.self = cyc;
  let refused = false;
  try { await obj.storage.put("cyc", cyc); } catch { refused = true; }
  expect(refused).toBe(true);
});

test("the stats page renders from its template", async (obj) => {
  await obj.rpc("add", "x");
  const res = await obj.fetch("/stats");
  const html = await res.text();
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(html).toContain("<td>Total</td><td>1</td>");
  expect(html).not.toContain("{{");
});
