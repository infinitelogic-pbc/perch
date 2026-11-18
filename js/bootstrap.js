// perch runtime bootstrap: the Workers globals a Durable Object class expects,
// and ctx.storage backed by the object file. Runs once per isolate, before the
// object's module graph loads.
((globalThis) => {
  "use strict";
  const core = Deno.core;
  const ops = core.ops;
  const EMPTY = new Uint8Array(0);

  // ------------------------------------------------------------ console
  function show(v) {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack || String(v);
    if (v === undefined) return "undefined";
    if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
    try {
      return JSON.stringify(v, (_k, x) =>
        typeof x === "bigint" ? `${x}n` : x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x);
    } catch {
      return String(v);
    }
  }
  function toU8(b) {
    if (b instanceof Uint8Array) return b;
    if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    throw new TypeError("expected bytes");
  }

  // In a browser (the perch web runtime) Request, Response, URL, timers and the
  // rest are native, so only ctx.storage and the dispatcher below are needed.
  const NATIVE = globalThis.__perchNativeGlobals === true;

  function installGlobals() {
  const log = (level) => (...args) => ops.op_log(level, args.map(show).join(" "));
  globalThis.console = {
    log: log("log"), info: log("info"), debug: log("debug"), warn: log("warn"), error: log("error"),
    trace: log("debug"), dir: log("log"), table: log("log"), time() {}, timeEnd() {}, assert(c, ...a) { if (!c) log("error")("Assertion failed", ...a); },
  };

  // ------------------------------------------------------------ timers & misc
  globalThis.setTimeout = (cb, ms = 0, ...args) => core.createTimer(cb, Math.max(0, Number(ms) || 0), args, false, true, false);
  globalThis.setInterval = (cb, ms = 0, ...args) => core.createTimer(cb, Math.max(1, Number(ms) || 1), args, true, true, false);
  globalThis.clearTimeout = globalThis.clearInterval = (t) => { if (t) core.cancelTimer(t); };
  globalThis.queueMicrotask = (fn) => { Promise.resolve().then(fn); };
  globalThis.structuredClone = (v) => core.deserialize(core.serialize(v));
  globalThis.self = globalThis;

  class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(s = "") { return core.encode(String(s)); }
  }
  class TextDecoder {
    constructor(label = "utf-8") { this.encoding = String(label).toLowerCase(); }
    decode(b) {
      if (b == null) return "";
      return core.decode(toU8(b));
    }
  }
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  globalThis.btoa = (s) => {
    s = String(s);
    let out = "";
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new Error("btoa: character out of range");
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (i + 1 < s.length ? B64[n >> 6 & 63] : "=") + (i + 2 < s.length ? B64[n & 63] : "=");
    }
    return out;
  };
  globalThis.atob = (s) => {
    s = String(s).replace(/[\s=]/g, "");
    let out = "", buf = 0, bits = 0;
    for (const ch of s) {
      const v = B64.indexOf(ch);
      if (v < 0) throw new Error("atob: invalid character");
      buf = (buf << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 255); }
    }
    return out;
  };

  globalThis.crypto = {
    randomUUID: () => ops.op_uuid_v4(),
    getRandomValues(arr) {
      const bytes = ops.op_random_bytes(arr.byteLength);
      new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(bytes);
      return arr;
    },
  };

  // ------------------------------------------------------------ URL
  class URLSearchParams {
    constructor(init = "") {
      this._list = [];
      this._url = null;
      if (typeof init === "string") this._parse(init);
      else if (init instanceof URLSearchParams) this._list = init._list.map((p) => [...p]);
      else if (Array.isArray(init)) this._list = init.map(([k, v]) => [String(k), String(v)]);
      else if (init && typeof init === "object") this._list = Object.entries(init).map(([k, v]) => [k, String(v)]);
    }
    _parse(s) {
      s = s.startsWith("?") ? s.slice(1) : s;
      this._list = s ? s.split("&").filter(Boolean).map((pair) => {
        const i = pair.indexOf("=");
        const dec = (x) => decodeURIComponent(x.replace(/\+/g, " "));
        return i < 0 ? [dec(pair), ""] : [dec(pair.slice(0, i)), dec(pair.slice(i + 1))];
      }) : [];
    }
    _update() { if (this._url) this._url._setSearch(this.toString()); }
    get size() { return this._list.length; }
    get(k) { const p = this._list.find(([n]) => n === k); return p ? p[1] : null; }
    getAll(k) { return this._list.filter(([n]) => n === k).map((p) => p[1]); }
    has(k) { return this._list.some(([n]) => n === k); }
    set(k, v) {
      const i = this._list.findIndex(([n]) => n === k);
      if (i < 0) this._list.push([k, String(v)]);
      else { this._list[i][1] = String(v); this._list = this._list.filter(([n], j) => n !== k || j === i); }
      this._update();
    }
    append(k, v) { this._list.push([k, String(v)]); this._update(); }
    delete(k) { this._list = this._list.filter(([n]) => n !== k); this._update(); }
    sort() { this._list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this._update(); }
    forEach(fn, self) { for (const [k, v] of this._list) fn.call(self, v, k, this); }
    keys() { return this._list.map((p) => p[0])[Symbol.iterator](); }
    values() { return this._list.map((p) => p[1])[Symbol.iterator](); }
    entries() { return this._list.map((p) => [...p])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toString() {
      const enc = (x) => encodeURIComponent(x).replace(/%20/g, "+");
      return this._list.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
    }
  }

  class URL {
    constructor(href, base) {
      this._p = JSON.parse(ops.op_url_parse(String(href), base === undefined ? null : String(base)));
      this._sp = null;
    }
    static canParse(href, base) { try { new URL(href, base); return true; } catch { return false; } }
    _set(part, v) { this._p = JSON.parse(ops.op_url_set(this._p.href, part, String(v))); if (this._sp && part !== "search") this._sp._parse(this._p.search); else if (this._sp && part === "search") this._sp._parse(this._p.search); }
    _setSearch(s) { this._p = JSON.parse(ops.op_url_set(this._p.href, "search", s)); }
    get searchParams() {
      if (!this._sp) { this._sp = new URLSearchParams(this._p.search); this._sp._url = this; }
      return this._sp;
    }
    toString() { return this._p.href; }
    toJSON() { return this._p.href; }
  }
  for (const k of ["href", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"]) {
    Object.defineProperty(URL.prototype, k, { get() { return this._p[k]; }, set(v) { this._set(k, v); } });
  }
  Object.defineProperty(URL.prototype, "origin", { get() { return this._p.origin; } });
  globalThis.URL = URL;
  globalThis.URLSearchParams = URLSearchParams;

  // ------------------------------------------------------------ Headers / Request / Response
  class Headers {
    constructor(init) {
      this._m = new Map();
      if (init instanceof Headers) for (const [k, v] of init) this.append(k, v);
      else if (Array.isArray(init)) for (const [k, v] of init) this.append(k, v);
      else if (init && typeof init === "object") for (const k of Object.keys(init)) this.append(k, init[k]);
    }
    append(k, v) { k = String(k).toLowerCase(); const a = this._m.get(k); if (a) a.push(String(v)); else this._m.set(k, [String(v)]); }
    set(k, v) { this._m.set(String(k).toLowerCase(), [String(v)]); }
    get(k) { const a = this._m.get(String(k).toLowerCase()); return a ? a.join(", ") : null; }
    getSetCookie() { return this._m.get("set-cookie") || []; }
    has(k) { return this._m.has(String(k).toLowerCase()); }
    delete(k) { this._m.delete(String(k).toLowerCase()); }
    forEach(fn, self) { for (const [k, v] of this) fn.call(self, v, k, this); }
    *entries() { for (const k of [...this._m.keys()].sort()) yield [k, this.get(k)]; }
    *keys() { for (const [k] of this.entries()) yield k; }
    *values() { for (const [, v] of this.entries()) yield v; }
    [Symbol.iterator]() { return this.entries(); }
  }
  globalThis.Headers = Headers;

  function bodyBytes(body, headers) {
    if (body == null) return null;
    if (typeof body === "string") {
      if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
      return core.encode(body);
    }
    if (body instanceof URLSearchParams) {
      if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      return core.encode(body.toString());
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new Uint8Array(toU8(body));
    throw new TypeError("perch v0 bodies are strings, bytes or URLSearchParams (streams are not supported yet)");
  }

  class Body {
    _init(body, headers) { this._bytes = bodyBytes(body, headers); this._used = false; }
    get body() { return this._bytes; }
    get bodyUsed() { return this._used; }
    _consume() {
      if (this._used) throw new TypeError("body already used");
      this._used = true;
      return this._bytes || EMPTY;
    }
    async arrayBuffer() { const b = this._consume(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    async bytes() { return new Uint8Array(this._consume()); }
    async text() { return core.decode(this._consume()); }
    async json() { return JSON.parse(await this.text()); }
    async formData() { throw new TypeError("formData() is not supported in perch v0"); }
  }

  class Request extends Body {
    constructor(input, init = {}) {
      super();
      const src = input instanceof Request ? input : null;
      this.url = src ? src.url : new URL(String(input)).href;
      this.method = String(init.method || (src && src.method) || "GET").toUpperCase();
      this.headers = new Headers(init.headers || (src && src.headers));
      this._init(init.body !== undefined ? init.body : src ? src._bytes : null, this.headers);
      this.signal = init.signal || null;
      this.cf = init.cf || {};
    }
    clone() { return new Request(this.url, { method: this.method, headers: this.headers, body: this._bytes }); }
  }

  class Response extends Body {
    constructor(body = null, init = {}) {
      super();
      this.status = init.status ?? 200;
      if (this.status < 101 || this.status > 599) throw new RangeError(`invalid status ${this.status}`);
      this.statusText = init.statusText ?? "";
      this.headers = new Headers(init.headers);
      this._init(body, this.headers);
      this.type = "default";
      this.redirected = false;
      this.url = "";
      this.webSocket = null;
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    clone() { return new Response(this._bytes, { status: this.status, statusText: this.statusText, headers: this.headers }); }
    static json(data, init = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      return new Response(JSON.stringify(data), { ...init, headers });
    }
    static redirect(url, status = 302) { return new Response(null, { status, headers: { location: String(url) } }); }
    static error() { const r = new Response(null, { status: 500 }); r.type = "error"; return r; }
  }
  globalThis.Request = Request;
  globalThis.Response = Response;
  globalThis.fetch = async () => {
    throw new Error("outbound fetch is not available in perch v0 (bindings, including an allowlisted fetch, come later)");
  };
  } // installGlobals
  if (!NATIVE) installGlobals();

  // ------------------------------------------------------------ KV value encoding
  // Values in _perch_kv are UTF-8 JSON, readable by any runtime (native V8, a
  // browser, Cloudflare tooling). Plain JSON values are stored as they are;
  // everything else structured clone can carry is tagged with "$perch". Shared
  // references are stored once per use, and cycles are refused.
  const TYPED = ["Uint8Array", "Int8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "DataView"];
  function b64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function kvTag(v, seen) {
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number") {
      if (Number.isFinite(v) && !Object.is(v, -0)) return v;
      return { $perch: "number", v: Object.is(v, -0) ? "-0" : String(v) };
    }
    if (v === undefined) return { $perch: "undefined" };
    if (typeof v === "bigint") return { $perch: "bigint", v: v.toString() };
    if (typeof v === "function" || typeof v === "symbol") throw new TypeError(`cannot store a ${typeof v} in key-value storage`);
    if (seen.includes(v)) throw new TypeError("cannot store a value that contains itself in key-value storage");
    seen.push(v);
    let out;
    if (v instanceof Date) out = { $perch: "date", v: Number.isNaN(v.getTime()) ? null : v.getTime() };
    else if (v instanceof ArrayBuffer) out = { $perch: "bytes", t: "ArrayBuffer", v: b64(new Uint8Array(v)) };
    else if (ArrayBuffer.isView(v)) {
      const t = TYPED.find((n) => typeof globalThis[n] === "function" && v instanceof globalThis[n]) || "Uint8Array";
      out = { $perch: "bytes", t, v: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    } else if (v instanceof Map) out = { $perch: "map", v: [...v].map(([k, x]) => [kvTag(k, seen), kvTag(x, seen)]) };
    else if (v instanceof Set) out = { $perch: "set", v: [...v].map((x) => kvTag(x, seen)) };
    else if (v instanceof RegExp) out = { $perch: "regexp", v: [v.source, v.flags] };
    else if (v instanceof Error) out = { $perch: "error", v: { name: v.name, message: v.message, stack: v.stack } };
    else if (Array.isArray(v)) out = Array.from(v, (x) => kvTag(x, seen));
    else {
      const o = {};
      for (const k of Object.keys(v)) o[k] = kvTag(v[k], seen);
      out = Object.prototype.hasOwnProperty.call(v, "$perch") ? { $perch: "object", v: o } : o;
    }
    seen.pop();
    return out;
  }
  function kvUntag(v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(kvUntag);
    if (typeof v.$perch !== "string") {
      const o = {};
      for (const k of Object.keys(v)) o[k] = kvUntag(v[k]);
      return o;
    }
    switch (v.$perch) {
      case "number": return v.v === "-0" ? -0 : Number(v.v);
      case "undefined": return undefined;
      case "bigint": return BigInt(v.v);
      case "date": return new Date(v.v === null ? NaN : v.v);
      case "bytes": {
        const u8 = unb64(v.v);
        if (v.t === "ArrayBuffer") return u8.buffer;
        if (v.t === "Uint8Array" || typeof globalThis[v.t] !== "function") return u8;
        if (v.t === "DataView") return new DataView(u8.buffer);
        return new globalThis[v.t](u8.buffer, 0, u8.byteLength / globalThis[v.t].BYTES_PER_ELEMENT);
      }
      case "map": return new Map(v.v.map(([k, x]) => [kvUntag(k), kvUntag(x)]));
      case "set": return new Set(v.v.map(kvUntag));
      case "regexp": return new RegExp(v.v[0], v.v[1]);
      case "error": { const e = new Error(v.v.message); e.name = v.v.name; e.stack = v.v.stack; return e; }
      case "object": { const o = {}; for (const k of Object.keys(v.v)) o[k] = kvUntag(v.v[k]); return o; }
      default: throw new Error(`unknown key-value type tag ${v.$perch}; this file was written by a newer perch`);
    }
  }
  function kvEncode(v) { return core.encode(JSON.stringify(kvTag(v, []))); }
  function kvDecode(bytes) {
    // Files written before the portable encoding hold V8's own serialization
    // (first byte 0xFF). The native runtime still reads those; others cannot.
    if (bytes.length && bytes[0] === 0xff) {
      if (typeof core.deserialize === "function") return core.deserialize(bytes);
      throw new Error("this value was stored by an older perch in a V8-only format; open the object once with the perch binary and write the key again to convert it");
    }
    return kvUntag(JSON.parse(core.decode(bytes)));
  }

  // ------------------------------------------------------------ storage
  function bind(v) {
    if (v === undefined) throw new TypeError("cannot bind undefined; use null");
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "bigint") return Number(v);
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { $b: Array.from(toU8(v)) };
    if (v !== null && typeof v === "object") throw new TypeError("cannot bind an object; JSON.stringify it first");
    return v;
  }
  function unbind(v) {
    if (v !== null && typeof v === "object" && Array.isArray(v.$b)) return new Uint8Array(v.$b).buffer;
    return v;
  }

  class SqlStorageCursor {
    constructor(r) {
      this.columnNames = r.columns;
      this._rows = r.rows.map((row) => row.map(unbind));
      this._i = 0;
      this.rowsRead = r.rowsRead;
      this.rowsWritten = r.rowsWritten;
    }
    _obj(row) { const o = {}; this.columnNames.forEach((c, i) => { o[c] = row[i]; }); return o; }
    next() {
      if (this._i >= this._rows.length) return { done: true, value: undefined };
      return { done: false, value: this._obj(this._rows[this._i++]) };
    }
    toArray() { const out = []; for (let r = this.next(); !r.done; r = this.next()) out.push(r.value); return out; }
    one() {
      const rest = this._rows.length - this._i;
      if (rest === 0) throw new Error("Expected exactly one result from SQL query, but got no results.");
      if (rest > 1) throw new Error("Expected exactly one result from SQL query, but got multiple results.");
      return this.next().value;
    }
    raw() {
      const self = this;
      const it = {
        next() { return self._i < self._rows.length ? { done: false, value: self._rows[self._i++] } : { done: true, value: undefined }; },
        toArray() { const out = []; for (let r = it.next(); !r.done; r = it.next()) out.push(r.value); return out; },
        [Symbol.iterator]() { return it; },
      };
      return it;
    }
    [Symbol.iterator]() { return this; }
  }

  const sql = {
    exec(query, ...bindings) { return new SqlStorageCursor(ops.op_sql_exec(String(query), bindings.map(bind))); },
    get databaseSize() { return ops.op_db_size(); },
  };

  function txnSync(fn) {
    ops.op_txn("begin");
    let r;
    try { r = fn(); } catch (e) { ops.op_txn("rollback"); throw e; }
    if (r && typeof r.then === "function") { ops.op_txn("rollback"); throw new TypeError("transactionSync() callback must be synchronous"); }
    ops.op_txn("commit");
    return r;
  }

  const storage = {
    sql,
    async get(k) {
      if (Array.isArray(k)) {
        const m = new Map();
        for (const key of k) { const b = ops.op_kv_get(String(key)); if (b != null) m.set(key, kvDecode(b)); }
        return m;
      }
      const b = ops.op_kv_get(String(k));
      return b == null ? undefined : kvDecode(b);
    },
    async put(k, v) {
      if (k !== null && typeof k === "object") {
        for (const key of Object.keys(k)) ops.op_kv_put(key, kvEncode(k[key]));
        return;
      }
      ops.op_kv_put(String(k), kvEncode(v));
    },
    async delete(k) {
      if (Array.isArray(k)) { let n = 0; for (const key of k) if (ops.op_kv_delete(String(key))) n++; return n; }
      return ops.op_kv_delete(String(k));
    },
    async list(opts = {}) {
      const m = new Map();
      for (const [k, b] of ops.op_kv_list(opts)) m.set(k, kvDecode(b));
      return m;
    },
    async deleteAll() { ops.op_kv_delete_all(); },
    async getAlarm() { const t = ops.op_alarm_get(); return t < 0 ? null : t; },
    async setAlarm(t) {
      const ms = t instanceof Date ? t.getTime() : Number(t);
      if (!Number.isFinite(ms)) throw new TypeError("setAlarm() needs a Date or epoch milliseconds");
      ops.op_alarm_set(ms);
    },
    async deleteAlarm() { ops.op_alarm_delete(); },
    transactionSync: txnSync,
    async transaction(fn) {
      ops.op_txn("begin");
      const txn = { rollback() { this._rb = true; } };
      try {
        const r = await fn(txn);
        if (txn._rb) ops.op_txn("rollback"); else ops.op_txn("commit");
        return r;
      } catch (e) { ops.op_txn("rollback"); throw e; }
    },
    async sync() {},
  };
  // Object code may also write `this.ctx.storage.kv` style; keep the CF shape only.

  // ------------------------------------------------------------ the object
  const blockers = [];
  const waits = [];
  const state = {
    mod: null,
    instance: null,
    env: {},
  };

  class DurableObject {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  }
  class WorkerEntrypoint {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  }
  class RpcTarget {}

  function makeCtx(name) {
    const idStr = name;
    return {
      id: { name, toString: () => idStr, equals: (o) => String(o) === idStr },
      storage,
      blockConcurrencyWhile(fn) { const p = Promise.resolve().then(fn); blockers.push(p); return p; },
      waitUntil(p) { waits.push(Promise.resolve(p)); },
      acceptWebSocket() { throw new Error("WebSockets are not available in perch v0"); },
      getWebSockets() { return []; },
      setWebSocketAutoResponse() {},
      abort(reason) { throw new Error(`object aborted: ${reason ?? ""}`); },
    };
  }

  const NOT_RPC = new Set(["constructor", "fetch", "alarm", "webSocketMessage", "webSocketClose", "webSocketError", "ctx", "env"]);

  async function run(id, ev) {
    switch (ev.kind) {
      case "init": {
        const Cls = state.mod[ev.className];
        if (typeof Cls !== "function") {
          const exported = Object.keys(state.mod).join(", ") || "nothing";
          throw new Error(`the entry module does not export class ${ev.className} (it exports ${exported})`);
        }
        Object.assign(state.env, ev.env || {});
        state.instance = new Cls(makeCtx(ev.name), state.env);
        await settle(blockers);
        return { meta: {} };
      }
      case "fetch": {
        const obj = state.instance;
        // No fetch() and no static file matched: a plain 404, as the export does.
        if (typeof obj.fetch !== "function") {
          return { meta: { status: 404, headers: [["content-type", "text/plain;charset=UTF-8"]] }, body: core.encode("Not found") };
        }
        const body = ops.op_take_body(id);
        const req = new Request(ev.url, { method: ev.method, headers: ev.headers, body: ev.method === "GET" || ev.method === "HEAD" ? null : body });
        const res = await obj.fetch(req);
        if (!(res instanceof Response)) throw new TypeError("fetch() must return a Response");
        return { meta: { status: res.status, headers: [...res.headers] }, body: NATIVE ? new Uint8Array(await res.arrayBuffer()) : res._bytes || EMPTY };
      }
      case "rpc": {
        const obj = state.instance;
        const m = String(ev.method);
        if (NOT_RPC.has(m) || m.startsWith("_") || m in Object.prototype || typeof obj[m] !== "function") {
          throw new Error(`${m} is not a public RPC method on this class`);
        }
        const result = await obj[m](...(ev.args || []));
        return { meta: { result: result === undefined ? null : JSON.parse(JSON.stringify(result)) } };
      }
      case "alarm": {
        const obj = state.instance;
        if (typeof obj.alarm !== "function") return { meta: { missing: true } };
        await obj.alarm({ retryCount: ev.retryCount || 0, isRetry: (ev.retryCount || 0) > 0 });
        return { meta: {} };
      }
      case "test_list":
        return { meta: { tests: tests.map((t) => ({ file: t.file, name: t.name })) } };
      case "test_run": {
        const t = tests.find((x) => x.file === ev.file && x.name === ev.name);
        if (!t) throw new Error(`no test ${JSON.stringify(ev.name)} in ${ev.file}`);
        await t.fn(testObject(ev.objectName));
        return { meta: {} };
      }
      default:
        throw new Error(`unknown event ${ev.kind}`);
    }
  }

  // ------------------------------------------------------------ tests (perch:test)
  // Test files register with test(name, fn). Each test runs in its own event
  // against a fresh, empty copy of the object, driving the real class instance.
  const tests = [];
  let testFile = null;
  let clockOffset = 0;
  const RealDate = Date;

  function installClock() {
    if (globalThis.Date !== RealDate) return;
    class TestDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(RealDate.now() + clockOffset); else super(...a); }
      static now() { return RealDate.now() + clockOffset; }
    }
    globalThis.Date = TestDate;
  }

  function testObject(name) {
    const inst = () => state.instance;
    return {
      /** Call the class's fetch(). A plain object body is sent as JSON. */
      async fetch(path, init = {}) {
        const headers = new Headers(init.headers);
        let body = init.body;
        if (body != null && typeof body === "object" && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && !(body instanceof URLSearchParams)) {
          body = JSON.stringify(body);
          if (!headers.has("content-type")) headers.set("content-type", "application/json");
        }
        const method = String(init.method || (body != null ? "POST" : "GET")).toUpperCase();
        if (typeof inst().fetch !== "function") return new Response("Not found", { status: 404 });
        const url = /^https?:/.test(path) ? path : `http://${name}.perch.local${path}`;
        return await inst().fetch(new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? null : body }));
      },
      /** Call a public method, with the same rules and JSON round trip as RPC. */
      async rpc(method, ...args) {
        const obj = inst();
        const m = String(method);
        if (NOT_RPC.has(m) || m.startsWith("_") || m in Object.prototype || typeof obj[m] !== "function") {
          throw new Error(`${m} is not a public RPC method on this class`);
        }
        const r = await obj[m](...args);
        return r === undefined ? null : JSON.parse(JSON.stringify(r));
      },
      /** Run alarm() now. */
      async alarm() {
        if (typeof inst().alarm !== "function") throw new Error("this class has no alarm() handler");
        await inst().alarm({ retryCount: 0, isRetry: false });
      },
      /** SQL over the data tables, for seeding and assertions. Returns rows. */
      sql(query, ...bindings) { return sql.exec(query, ...bindings).toArray(); },
      storage,
      /** The object's clock: Date.now() and new Date() follow it. */
      clock: {
        now: () => Date.now(),
        set(ms) { clockOffset = (ms instanceof RealDate ? ms.getTime() : Number(ms)) - RealDate.now(); },
        advance(ms) { clockOffset += Number(ms); },
      },
    };
  }

  function expect(actual) {
    const make = (neg) => {
      const check = (pass, what) => {
        if (neg ? pass : !pass) throw new Error(`expected ${show(actual)} ${neg ? "not " : ""}${what}`);
      };
      return {
        toBe(e) { check(Object.is(actual, e), `to be ${show(e)}`); },
        toEqual(e) { check(JSON.stringify(actual) === JSON.stringify(e), `to equal ${show(e)}`); },
        toBeTruthy() { check(!!actual, "to be truthy"); },
        toBeFalsy() { check(!actual, "to be falsy"); },
        toBeNull() { check(actual === null, "to be null"); },
        toBeDefined() { check(actual !== undefined, "to be defined"); },
        toBeUndefined() { check(actual === undefined, "to be undefined"); },
        toContain(e) { check(actual != null && typeof actual.includes === "function" && actual.includes(e), `to contain ${show(e)}`); },
        toHaveLength(n) { check(actual != null && actual.length === n, `to have length ${n}`); },
        toBeGreaterThan(n) { check(actual > n, `to be greater than ${show(n)}`); },
        toBeLessThan(n) { check(actual < n, `to be less than ${show(n)}`); },
        toMatch(re) { check(typeof actual === "string" && (re instanceof RegExp ? re.test(actual) : actual.includes(re)), `to match ${re}`); },
      };
    };
    const e = make(false);
    e.not = make(true);
    return e;
  }

  const testApi = {
    test(name, fn) {
      if (typeof fn !== "function") throw new TypeError("test(name, fn) needs a function");
      tests.push({ file: testFile, name: String(name), fn });
    },
    expect,
  };

  async function settle(list) {
    while (list.length) {
      const batch = list.splice(0);
      await Promise.all(batch);
    }
  }

  globalThis.__perch = {
    DurableObject,
    WorkerEntrypoint,
    RpcTarget,
    env: state.env,
    setModule(m) { state.mod = m; },
    testApi,
    beginTestFile(f) { testFile = f; installClock(); },
    dispatch(id, ev) {
      run(id, ev).then(
        async (out) => {
          await settle(waits).catch((e) => console.error("waitUntil rejected:", e));
          ops.op_event_done(id, JSON.stringify({ ok: true, ...out.meta }), out.body || EMPTY);
        },
        (e) => ops.op_event_error(id, e && e.stack ? String(e.stack) : String(e)),
      );
    },
  };
})(globalThis);
