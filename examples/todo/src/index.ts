import { DurableObject } from "cloudflare:workers";
import { uuidv7 } from "./uuid";
import statsPage from "./stats.html";
import { migrate } from "./schema";

type TodoRow = { id: string; title: string; done: number; created_at: number; done_at: number | null };

const DAY = 24 * 60 * 60 * 1000;

/** A to-do list with a nightly cleanup that drops items done for over a day. */
export class Todo extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    migrate(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(nextMidnight());
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    // The UI is static (public/); this page is dynamic, from an imported template.
    if (url.pathname === "/stats" && request.method === "GET") {
      const s = await this.stats();
      const vars: Record<string, string> = {
        total: String(s.total),
        open: String(s.open),
        done: String(s.done),
        lastCleanup: s.lastCleanup ? new Date(s.lastCleanup).toISOString() : "never",
      };
      const html = statsPage.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => vars[k] ?? "");
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    // Methods are not reachable over HTTP; what a page or a script needs is a route.
    if (url.pathname === "/api/stats" && request.method === "GET") return Response.json(await this.stats());
    if (url.pathname === "/api/cleanup" && request.method === "POST") {
      const body = (await request.json()) as { retentionMs?: number; inMs?: number };
      if (body.retentionMs != null) await this.setRetention(body.retentionMs);
      const at = body.inMs != null ? await this.scheduleCleanup(body.inMs) : null;
      return Response.json({ at });
    }
    if (parts[0] !== "todos") return Response.json({ error: "not found" }, { status: 404 });
    const id = parts[1];

    if (request.method === "GET" && !id) {
      const done = url.searchParams.get("done");
      const rows = done == null
        ? this.ctx.storage.sql.exec("SELECT * FROM todos ORDER BY created_at").toArray()
        : this.ctx.storage.sql.exec("SELECT * FROM todos WHERE done = ? ORDER BY created_at", Number(done)).toArray();
      return Response.json(rows);
    }
    if (request.method === "POST" && !id) {
      const body = (await request.json()) as { title?: string };
      if (!body.title) return Response.json({ error: "title is required" }, { status: 400 });
      return Response.json(this.add(body.title), { status: 201 });
    }
    if (request.method === "PATCH" && id) {
      const body = (await request.json()) as { done?: boolean; title?: string };
      const t = this.setDone(id, body.done ?? false, body.title);
      return t ? Response.json(t) : Response.json({ error: "not found" }, { status: 404 });
    }
    if (request.method === "DELETE" && id) {
      const n = this.ctx.storage.sql.exec("DELETE FROM todos WHERE id = ?", id).rowsWritten;
      return n ? new Response(null, { status: 204 }) : Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  // ---- RPC

  add(title: string): TodoRow {
    const t: TodoRow = { id: uuidv7(), title, done: 0, created_at: Date.now(), done_at: null };
    this.ctx.storage.sql.exec(
      "INSERT INTO todos (id, title, done, created_at, done_at) VALUES (?, ?, ?, ?, ?)",
      t.id, t.title, t.done, t.created_at, t.done_at,
    );
    return t;
  }

  setDone(id: string, done: boolean, title?: string): TodoRow | null {
    this.ctx.storage.sql.exec(
      "UPDATE todos SET done = ?, done_at = ?, title = coalesce(?, title) WHERE id = ?",
      done ? 1 : 0, done ? Date.now() : null, title ?? null, id,
    );
    return this.ctx.storage.sql.exec("SELECT * FROM todos WHERE id = ?", id).toArray()[0] as TodoRow ?? null;
  }

  async stats(): Promise<{ total: number; open: number; done: number; lastCleanup: number | null }> {
    const r = this.ctx.storage.sql
      .exec("SELECT count(*) AS total, coalesce(sum(done = 0), 0) AS open, coalesce(sum(done = 1), 0) AS done FROM todos")
      .one() as { total: number; open: number; done: number };
    const last = await this.ctx.storage.get<{ at: number; removed: number }>("lastCleanup");
    return { ...r, lastCleanup: last?.at ?? null };
  }

  /** How long a done item survives the nightly cleanup. */
  async setRetention(ms: number): Promise<void> {
    await this.ctx.storage.put("retentionMs", ms);
  }

  /** Move the next cleanup to `ms` from now (for testing the alarm). */
  async scheduleCleanup(ms: number): Promise<number> {
    const at = Date.now() + ms;
    await this.ctx.storage.setAlarm(at);
    return at;
  }

  // ---- alarm: nightly cleanup

  async alarm(): Promise<void> {
    const retention = (await this.ctx.storage.get<number>("retentionMs")) ?? DAY;
    const cutoff = Date.now() - retention;
    const removed = this.ctx.storage.sql.exec("DELETE FROM todos WHERE done = 1 AND done_at <= ?", cutoff).rowsWritten;
    await this.ctx.storage.put("lastCleanup", { at: Date.now(), removed });
    console.log(`cleanup removed ${removed}`);
    await this.ctx.storage.setAlarm(nextMidnight());
  }
}

function nextMidnight(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}
