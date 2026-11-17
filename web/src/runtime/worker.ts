// The Web Worker that holds one open object. The page sends it file bytes and
// requests; it answers with responses, logs and saved bytes.
//
// One object per worker (the class lives on the worker's global), so the page
// starts a fresh worker for each file it opens.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
// perch's own bootstrap, the same file the native binary embeds.
import bootstrap from "../../../js/bootstrap.js?raw";
import { ObjRuntime, type Req } from "./objrun";

type In =
  | { type: "open"; bytes: Uint8Array }
  | { type: "fetch"; id: number; req: Req }
  | { type: "export"; id: number };

const post = (m: unknown, transfer: Transferable[] = []) => (self as any).postMessage(m, transfer);
let rt: ObjRuntime | null = null;
let lastDirty = false;

function show(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function status() {
  if (!rt) return;
  if (rt.dirty !== lastDirty) {
    lastDirty = rt.dirty;
    post({ type: "dirty", dirty: rt.dirty });
  }
}

async function open(bytes: Uint8Array) {
  const sqlite3 = await (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });
  // Object code logs with console; show that in the page.
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const real = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      post({ type: "log", level, message: args.map(show).join(" ") });
      real(...args);
    };
  }
  // As in native perch v0, object code has no network: SQLite is loaded, so
  // nothing in this worker needs it any more.
  const g = self as any;
  const refuse = async () => {
    throw new Error("outbound fetch is not available in perch v0 (bindings, including an allowlisted fetch, come later)");
  };
  g.fetch = refuse;
  for (const k of ["XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "WebTransport"]) {
    try { g[k] = undefined; } catch {}
  }
  rt = await ObjRuntime.open(bytes, { sqlite3, bootstrap, onLog: (l) => post({ type: "log", ...l }) });
  post({ type: "opened", info: rt.info() });
  // Alarms fire only while this page is open.
  setInterval(async () => {
    if (!rt) return;
    try {
      if (await rt.tickAlarm()) post({ type: "info", info: rt.info() });
      status();
    } catch (e) {
      post({ type: "log", level: "error", message: `alarm: ${show(e)}` });
    }
  }, 500);
}

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    if (m.type === "open") {
      await open(m.bytes);
    } else if (m.type === "fetch") {
      if (!rt) throw new Error("no object is open");
      const res = await rt.fetch(m.req);
      post({ type: "response", id: m.id, res }, [res.body.buffer as ArrayBuffer]);
      status();
      if (m.req.method !== "GET" && m.req.method !== "HEAD") post({ type: "info", info: rt.info() });
    } else if (m.type === "export") {
      if (!rt) throw new Error("no object is open");
      const bytes = rt.export();
      lastDirty = false;
      post({ type: "exported", id: m.id, bytes }, [bytes.buffer as ArrayBuffer]);
    }
  } catch (err) {
    if (m.type === "open") post({ type: "open-failed", error: show(err) });
    else post({ type: "failed", id: (m as any).id, error: show(err) });
  }
};
