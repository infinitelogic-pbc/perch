// The perch runtime for browsers: opens a .perch file with SQLite compiled to
// WebAssembly and runs the object's class on the host's own JavaScript engine.
// It evaluates perch's own js/bootstrap.js, so ctx.storage, RPC rules and
// dispatch are the same code the native binary runs; this file supplies the
// "ops" underneath (SQL, KV, alarms) and the event loop around it.
//
// Environment-agnostic (a Web Worker, or bun for tests). One object per
// JavaScript global, because the object's class lives on globalThis.__perch.

import { CACHE_CONTROL, PUBLIC_DIR, contentType, decodePath, resolve } from "./assets";
import { link, type ToUrl } from "./loader";

export type Req = { method: string; url: string; headers: [string, string][]; body?: Uint8Array | null };
export type Res = { status: number; headers: [string, string][]; body: Uint8Array; asset?: string };
export type Log = { level: string; message: string };

export interface OpenOptions {
  /** The sqlite3 module from @sqlite.org/sqlite-wasm, already initialised. */
  sqlite3: any;
  /** Source text of perch/js/bootstrap.js. */
  bootstrap: string;
  /** How to turn module source into an importable URL (blob: by default). */
  toUrl?: ToUrl;
  onLog?: (l: Log) => void;
  /** Wall-clock limit for one event, in ms. */
  timeoutMs?: number;
}

const enum Mode { Privileged, Sandbox }
const EMPTY = new Uint8Array(0);
const INTROSPECTION = new Set(["table_info", "table_xinfo", "table_list", "index_list", "index_info", "index_xinfo", "foreign_key_list"]);

type Outcome = { ok: true; meta: any; body: Uint8Array } | { ok: false; error: string };

export class ObjRuntime {
  private db: any;
  private capi: any;
  private wasm: any;
  private mode: Mode = Mode.Privileged;
  private savepoint = 0;
  private alarmTouched = false;
  private nextId = 1;
  private pending = new Map<number, (o: Outcome) => void>();
  private bodies = new Map<number, Uint8Array>();
  private chain: Promise<unknown> = Promise.resolve();
  private manifest: Record<string, string> = {};
  private timeoutMs: number;
  private onLog: (l: Log) => void;
  /** Why the object's code is not running, if it failed to load or construct. */
  loadError: string | null = null;
  /** True once anything was written since open or the last export. */
  dirty = false;
  checkin = "";
  name = "";
  className = "";

  private constructor(sqlite3: any, opts: OpenOptions) {
    this.capi = sqlite3.capi;
    this.wasm = sqlite3.wasm;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.onLog = opts.onLog ?? (() => {});
  }

  static async open(bytes: Uint8Array, opts: OpenOptions): Promise<ObjRuntime> {
    const rt = new ObjRuntime(opts.sqlite3, opts);
    rt.openDb(opts.sqlite3, bytes);
    rt.name = rt.meta("name") ?? "object";
    rt.className = rt.meta("class") ?? "";
    rt.checkin = rt.meta("live_checkin") ?? "";
    const m = rt.db.selectValue("SELECT manifest FROM _perch_checkins WHERE id = ?", [rt.checkin]);
    if (!m) throw new Error("this file has no live check-in");
    rt.manifest = JSON.parse(m);
    try {
      await rt.loadCode(opts);
    } catch (e: any) {
      // As with `perch run`: a class that does not load is reported, and its
      // static files are still served.
      rt.loadError = String(e?.stack || e);
    }
    return rt;
  }

  // ------------------------------------------------------------ database

  private openDb(sqlite3: any, bytes: Uint8Array) {
    if (bytes.length < 100 || new TextDecoder().decode(bytes.subarray(0, 15)) !== "SQLite format 3") {
      throw new Error("this is not a portable object file (not a SQLite database)");
    }
    const copy = bytes.slice();
    // A file last written in WAL mode cannot be opened from memory. Every perch
    // commit checkpoints the WAL, so the main file is complete: mark it as a
    // rollback-journal database (header bytes 18 and 19).
    copy[18] = 1;
    copy[19] = 1;
    const { capi, wasm } = this;
    this.db = new sqlite3.oo1.DB(":memory:");
    const p = wasm.allocFromTypedArray(copy);
    const rc = capi.sqlite3_deserialize(
      this.db.pointer, "main", p, copy.length, copy.length,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );
    this.db.checkRc(rc);
    this.db.exec("PRAGMA foreign_keys = ON");
    // Format 1 named its reserved tables _obj_*. Rename them, as the native
    // binary does on open; the file is saved in format 2.
    const has = (t: string) => !!this.db.selectValue("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", [t]);
    if (has("_obj_meta") && !has("_perch_meta")) {
      this.db.exec("BEGIN");
      for (const t of ["meta", "blobs", "checkins", "migrations", "kv", "alarms", "changes"]) {
        if (has(`_obj_${t}`)) this.db.exec(`ALTER TABLE _obj_${t} RENAME TO _perch_${t}`);
      }
      this.db.exec("UPDATE _perch_meta SET value='2' WHERE key='format_version'; COMMIT;");
      this.dirty = true;
    }
    const v = this.meta("format_version");
    if (v !== "2") throw new Error(v ? `unsupported object file format version ${v}` : "this SQLite file is not a portable object (no _perch_meta)");
    const str = (x: any) => (typeof x === "number" ? (x ? wasm.cstrToJs(x) : null) : x ?? null);
    capi.sqlite3_set_authorizer(this.db.pointer, (_p: any, action: number, a1: any, a2: any, dbName: any) => {
      try {
        return this.authorize(action, str(a1), str(a2), str(dbName)) ? capi.SQLITE_OK : capi.SQLITE_DENY;
      } catch {
        return capi.SQLITE_DENY;
      }
    }, 0);
  }

  /** The same policy as `authorize` in perch/src/store.rs, for object code. */
  private authorize(action: number, a1: string | null, a2: string | null, dbName: string | null): boolean {
    if (this.mode === Mode.Privileged) return true;
    const c = this.capi;
    if (dbName === "temp") return false;
    const reserved = (t: string | null) => !!t && t.startsWith("_perch_");
    const internal = (t: string | null) => !!t && t.startsWith("sqlite_");
    switch (action) {
      case c.SQLITE_SELECT: case c.SQLITE_RECURSIVE: case c.SQLITE_FUNCTION:
        return true;
      case c.SQLITE_READ:
        return !reserved(a1);
      case c.SQLITE_INSERT: case c.SQLITE_DELETE: case c.SQLITE_UPDATE:
        return !reserved(a1) && !internal(a1);
      case c.SQLITE_PRAGMA:
        return INTROSPECTION.has((a1 ?? "").toLowerCase());
      default:
        // DDL, BEGIN/COMMIT/SAVEPOINT, ATTACH, temp objects: never from object code.
        return false;
    }
  }

  private priv<T>(f: () => T): T {
    const old = this.mode;
    this.mode = Mode.Privileged;
    try {
      return f();
    } finally {
      this.mode = old;
    }
  }

  private meta(key: string): string | null {
    return this.priv(() => {
      const has = this.db.selectValue("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='_perch_meta'");
      return has ? (this.db.selectValue("SELECT value FROM _perch_meta WHERE key = ?", [key]) ?? null) : null;
    });
  }

  private blob(hash: string): Uint8Array {
    const b = this.priv(() => this.db.selectValue("SELECT data FROM _perch_blobs WHERE hash = ?", [hash]));
    if (!(b instanceof Uint8Array)) throw new Error(`missing blob ${hash}`);
    return b;
  }

  // ------------------------------------------------------------ ops for bootstrap.js

  private ops() {
    const rt = this;
    const { capi } = this;
    const toBind = (v: any) => (v !== null && typeof v === "object" && Array.isArray(v.$b) ? new Uint8Array(v.$b) : v);
    const fromCell = (v: any) => (v instanceof Uint8Array ? { $b: Array.from(v) } : typeof v === "bigint" ? Number(v) : v);
    return {
      op_sql_exec(query: string, params: any[]) {
        const before = capi.sqlite3_total_changes(rt.db.pointer);
        const columns: string[] = [];
        const rows: any[][] = [];
        rt.db.exec({ sql: query, bind: params.length ? params.map(toBind) : undefined, rowMode: "array", resultRows: rows, columnNames: columns });
        const written = capi.sqlite3_total_changes(rt.db.pointer) - before;
        return { columns, rows: rows.map((r) => r.map(fromCell)), rowsRead: rows.length, rowsWritten: written };
      },
      op_db_size: () => rt.priv(() => Number(rt.db.selectValue("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()"))),
      op_txn(action: string) {
        rt.priv(() => {
          if (action === "begin") rt.db.exec(`SAVEPOINT perch_tx_${++rt.savepoint}`);
          else if (action === "commit") rt.db.exec(`RELEASE perch_tx_${rt.savepoint--}`);
          else { const n = rt.savepoint--; rt.db.exec(`ROLLBACK TO perch_tx_${n}; RELEASE perch_tx_${n}`); }
        });
      },
      op_kv_get: (key: string) => rt.priv(() => rt.db.selectValue("SELECT value FROM _perch_kv WHERE key = ?", [key]) ?? null),
      op_kv_put(key: string, value: Uint8Array) {
        rt.priv(() => rt.db.exec({ sql: "INSERT INTO _perch_kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", bind: [key, value] }));
      },
      op_kv_delete: (key: string) => rt.priv(() => { rt.db.exec({ sql: "DELETE FROM _perch_kv WHERE key = ?", bind: [key] }); return rt.db.changes() > 0; }),
      op_kv_list(o: any = {}) {
        let sql = "SELECT key, value FROM _perch_kv WHERE 1=1";
        const args: any[] = [];
        if (o.start != null) { sql += " AND key >= ?"; args.push(o.start); }
        if (o.startAfter != null) { sql += " AND key > ?"; args.push(o.startAfter); }
        if (o.end != null) { sql += " AND key < ?"; args.push(o.end); }
        if (o.prefix != null) { sql += " AND substr(key, 1, length(?)) = ?"; args.push(o.prefix, o.prefix); }
        sql += o.reverse ? " ORDER BY key DESC" : " ORDER BY key";
        if (o.limit != null) sql += ` LIMIT ${Math.max(0, Number(o.limit) | 0)}`;
        return rt.priv(() => rt.db.selectArrays(sql, args));
      },
      op_kv_delete_all() { rt.priv(() => rt.db.exec("DELETE FROM _perch_kv; DELETE FROM _perch_alarms;")); },
      op_alarm_get: () => rt.priv(() => Number(rt.db.selectValue("SELECT scheduled_at FROM _perch_alarms WHERE id = 1") ?? -1)),
      op_alarm_set(at: number) {
        rt.alarmTouched = true;
        rt.priv(() => rt.db.exec({ sql: "INSERT INTO _perch_alarms(id, scheduled_at, retry_count) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET scheduled_at = excluded.scheduled_at, retry_count = 0", bind: [Math.trunc(at)] }));
      },
      op_alarm_delete() {
        rt.alarmTouched = true;
        rt.priv(() => rt.db.exec("DELETE FROM _perch_alarms"));
      },
      op_log(level: string, message: string) { rt.onLog({ level, message }); },
      op_take_body(id: number) { const b = rt.bodies.get(id) ?? null; rt.bodies.delete(id); return b; },
      op_event_done(id: number, meta: string, body: Uint8Array) { rt.pending.get(id)?.({ ok: true, meta: JSON.parse(meta), body: body.slice() }); },
      op_event_error(id: number, message: string) { rt.pending.get(id)?.({ ok: false, error: message }); },
    };
  }

  // ------------------------------------------------------------ code

  private async loadCode(opts: OpenOptions) {
    const g = globalThis as any;
    const enc = new TextEncoder(), dec = new TextDecoder();
    g.__perchNativeGlobals = true;
    g.Deno = { ...(g.Deno ?? {}), core: { ops: this.ops(), encode: (s: string) => enc.encode(s), decode: (b: Uint8Array) => dec.decode(b) } };
    // Object code logs through console; send those to the host's log too.
    (0, eval)(opts.bootstrap);
    const files = new Map<string, Uint8Array>();
    for (const [path, hash] of Object.entries(this.manifest)) {
      if (!path.startsWith(PUBLIC_DIR)) files.set(path, this.blob(hash));
    }
    const toUrl: ToUrl = opts.toUrl ?? ((code) => URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    const main = this.meta("main") ?? "src/index.ts";
    const entry = await link(files, main, toUrl);
    this.mode = Mode.Sandbox; // top-level module code is sandboxed too
    let mod: any;
    try {
      mod = await import(/* @vite-ignore */ entry);
    } finally {
      this.mode = Mode.Privileged;
    }
    g.__perch.setModule(mod);
    const out = await this.event("init", { kind: "init", className: this.className, name: this.name, env: {} });
    if (!out.ok) throw new Error(`constructor failed: ${out.error}`);
  }

  // ------------------------------------------------------------ events

  /** One event, one transaction, one recorded changeset. Events never overlap. */
  private event(label: string, ev: any, body?: Uint8Array | null): Promise<Outcome> {
    const run = this.chain.then(() => this.runEvent(label, ev, body));
    this.chain = run.catch(() => {});
    return run;
  }

  private async runEvent(label: string, ev: any, body?: Uint8Array | null): Promise<Outcome> {
    const { capi, wasm, db } = this;
    const id = this.nextId++;
    const before = capi.sqlite3_total_changes(db.pointer);
    this.mode = Mode.Privileged;
    this.savepoint = 0;
    this.alarmTouched = false;
    db.exec("BEGIN");
    // Record every data write of this event as a session changeset.
    const pp = wasm.allocPtr();
    let session = 0;
    try {
      db.checkRc(capi.sqlite3session_create(db.pointer, "main", pp));
      session = wasm.peekPtr(pp);
    } finally {
      wasm.dealloc(pp);
    }
    capi.sqlite3session_table_filter(session, (_c: any, t: any) => {
      const name = typeof t === "number" ? wasm.cstrToJs(t) : String(t);
      return !name.startsWith("_perch_") || name === "_perch_kv" ? 1 : 0;
    }, 0);
    capi.sqlite3session_attach(session, null);

    let out: Outcome;
    try {
      if (body && body.length) this.bodies.set(id, body);
      const settled = new Promise<Outcome>((res) => this.pending.set(id, res));
      let timer: any;
      const timeout = new Promise<Outcome>((res) => {
        timer = setTimeout(() => res({ ok: false, error: `event exceeded ${this.timeoutMs / 1000}s wall clock` }), this.timeoutMs);
      });
      this.mode = Mode.Sandbox;
      (globalThis as any).__perch.dispatch(id, ev);
      out = await Promise.race([settled, timeout]);
      clearTimeout(timer);
    } catch (e: any) {
      out = { ok: false, error: String(e?.stack || e) };
    } finally {
      this.mode = Mode.Privileged;
      this.pending.delete(id);
      this.bodies.delete(id);
    }
    try {
      while (this.savepoint > 0) {
        const n = this.savepoint--;
        db.exec(`ROLLBACK TO perch_tx_${n}; RELEASE perch_tx_${n}`);
      }
      const pn = wasm.alloc(4), pc = wasm.allocPtr();
      let cs = EMPTY;
      try {
        db.checkRc(capi.sqlite3session_changeset(session, pn, pc));
        const n = wasm.peek32(pn), p = wasm.peekPtr(pc);
        if (n > 0) cs = wasm.heap8u().slice(Number(p), Number(p) + n);
        if (p) capi.sqlite3_free(p);
      } finally {
        wasm.dealloc(pn);
        wasm.dealloc(pc);
        capi.sqlite3session_delete(session);
      }
      if (cs.length) {
        db.exec({ sql: "INSERT INTO _perch_changes(at, event, checkin, changeset) VALUES (?, ?, ?, ?)", bind: [Date.now(), label, this.checkin, cs] });
      }
      // Writes made before a handler throws are kept, as on Cloudflare.
      db.exec("COMMIT");
    } catch (e: any) {
      try { db.exec("ROLLBACK"); } catch {}
      return { ok: false, error: `runtime error: ${e?.message || e}` };
    }
    if (capi.sqlite3_total_changes(db.pointer) !== before) this.dirty = true;
    return out;
  }

  // ------------------------------------------------------------ the HTTP surface (as `perch run`)

  private asset(req: Req): Res | null {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const u = new URL(req.url);
    if (u.pathname.startsWith("/.perch/")) return null;
    const r = resolve((p) => p in this.manifest, decodePath(u.pathname));
    if (!r) return null;
    if ("redirect" in r) {
      return { status: 307, headers: [["location", r.redirect + u.search]], body: EMPTY, asset: u.pathname };
    }
    const hash = this.manifest[r.file];
    const etag = `"${hash}"`;
    const headers: [string, string][] = [["content-type", contentType(r.file)], ["etag", etag], ["cache-control", CACHE_CONTROL]];
    const inm = req.headers.find(([k]) => k.toLowerCase() === "if-none-match")?.[1];
    if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*")) {
      return { status: 304, headers, body: EMPTY, asset: r.file };
    }
    const body = this.blob(hash);
    headers.push(["content-length", String(body.length)]);
    return { status: 200, headers, body: req.method === "HEAD" ? EMPTY : body, asset: r.file };
  }

  private text(status: number, message: string): Res {
    return { status, headers: [["content-type", "text/plain; charset=utf-8"]], body: new TextEncoder().encode(message) };
  }

  private json(status: number, value: unknown): Res {
    return { status, headers: [["content-type", "application/json"]], body: new TextEncoder().encode(JSON.stringify(value)) };
  }

  /** Static files first, then `POST /.perch/rpc/<method>`, then the class's fetch(). */
  async fetch(req: Req): Promise<Res> {
    const a = this.asset(req);
    if (a) return a;
    const u = new URL(req.url);
    const m = u.pathname.match(/^\/\.perch\/rpc\/([^/]+)$/);
    if (m && req.method === "POST") {
      let args: unknown[] = [];
      if (req.body?.length) {
        try {
          const v = JSON.parse(new TextDecoder().decode(req.body));
          args = Array.isArray(v) ? v : [v];
        } catch (e: any) {
          return this.json(400, { error: `body must be a JSON array of arguments: ${e.message}` });
        }
      }
      const r = await this.rpc(decodeURIComponent(m[1]), args);
      return "error" in r ? this.json(500, { error: r.error }) : this.json(200, { result: r.result });
    }
    if (this.loadError) return this.text(500, `${this.loadError}\n`);
    const out = await this.event("fetch", { kind: "fetch", method: req.method, url: req.url, headers: req.headers }, req.body);
    if (!out.ok) return this.text(500, `object threw: ${out.error}\n`);
    return { status: out.meta.status ?? 200, headers: out.meta.headers ?? [], body: out.body };
  }

  async rpc(method: string, args: unknown[]): Promise<{ result: unknown } | { error: string }> {
    if (this.loadError) return { error: this.loadError };
    const out = await this.event("rpc", { kind: "rpc", method, args });
    return out.ok ? { result: out.meta.result ?? null } : { error: out.error };
  }

  /** Fire the alarm if it is due. Call this on a timer; alarms need the page open. */
  async tickAlarm(): Promise<boolean> {
    if (this.loadError) return false;
    const row = this.priv(() => this.db.selectArray("SELECT scheduled_at, retry_count FROM _perch_alarms WHERE id = 1"));
    if (!row || Number(row[0]) > Date.now()) return false;
    const [at, retry] = [Number(row[0]), Number(row[1])];
    const out = await this.event("alarm", { kind: "alarm", retryCount: retry });
    const touched = this.alarmTouched;
    const missing = out.ok && out.meta.missing === true;
    this.priv(() => {
      const now = this.db.selectValue("SELECT scheduled_at FROM _perch_alarms WHERE id = 1");
      if (now == null || Number(now) !== at || touched) return; // the handler rescheduled or deleted it
      if (out.ok || missing || retry >= 6) this.db.exec({ sql: "DELETE FROM _perch_alarms WHERE id = 1 AND scheduled_at = ?", bind: [at] });
      else this.db.exec({ sql: "UPDATE _perch_alarms SET scheduled_at = ?, retry_count = ? WHERE id = 1", bind: [Date.now() + 1000 * 2 ** retry, retry + 1] });
    });
    this.dirty = true;
    if (!out.ok) this.onLog({ level: "error", message: `alarm failed: ${out.error}` });
    return true;
  }

  // ------------------------------------------------------------ file

  /** The object as file bytes, to save back to disk. */
  export(): Uint8Array {
    const bytes = this.priv(() => this.capi.sqlite3_js_db_export(this.db.pointer));
    this.dirty = false;
    return bytes;
  }

  info() {
    return this.priv(() => {
      const tables = this.db
        .selectValues("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_perch\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
        .map((name: string) => ({ name, rows: Number(this.db.selectValue(`SELECT count(*) FROM "${name.replace(/"/g, '""')}"`)) }));
      const ck = this.db.selectObject("SELECT message, created_at FROM _perch_checkins WHERE id = ?", [this.checkin]);
      const paths = Object.keys(this.manifest);
      const alarm = this.db.selectValue("SELECT scheduled_at FROM _perch_alarms WHERE id = 1");
      return {
        name: this.name,
        class: this.className,
        checkin: this.checkin,
        message: ck?.message ?? "",
        tables,
        files: paths.filter((p) => !p.startsWith(PUBLIC_DIR)),
        public: paths.filter((p) => p.startsWith(PUBLIC_DIR)),
        kvKeys: Number(this.db.selectValue("SELECT count(*) FROM _perch_kv")),
        changesets: Number(this.db.selectValue("SELECT count(*) FROM _perch_changes")),
        checkins: Number(this.db.selectValue("SELECT count(*) FROM _perch_checkins")),
        nextAlarm: alarm == null ? null : Number(alarm),
        loadError: this.loadError,
      };
    });
  }

  close() {
    try { this.db.close(); } catch {}
  }
}
