//! MCP over stdio (JSON-RPC 2.0, one message per line). One fixed tool set for
//! every object; the object file is chosen on the command line.

use std::path::PathBuf;

use anyhow::Result;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::tools::{CallArgs, ProposeArgs, Tools};

const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

pub const GUIDE: &str = r#"This server edits one portable durable object: a single SQLite file holding a Cloudflare-style Durable Object's code, history and data.

Workflow: describe_object → read_code → propose_change (code, tests and static files, applied to a preview copy of the file; the constructor runs there and the stored tests run) → read_object and call_object with target "preview" (try reads and writes against the preview) → release_change (refused while tests fail; makes the code live and starts it on the live data). read_object reads the live object with writes refused by the runtime; call_object makes write calls on it. To go back to earlier code, propose_change with from_checkin (ids are in describe_object).

Writing the object:
- The entry file is src/index.ts. It exports the object's class (the name describe_object reports) extending DurableObject from "cloudflare:workers". Constructor signature is (ctx, env); call super(ctx, env).
- Handlers: async fetch(request: Request): Promise<Response> is the only thing reachable over HTTP; public methods are RPC, callable here with kind "rpc" and from tests, never from a web page (give a page a route in fetch()); async alarm() runs when ctx.storage.setAlarm(epochMs) comes due.
- Storage: this.ctx.storage.sql.exec(sql, ...bindings) returns a cursor (.toArray(), .one(), .raw(), rowsWritten). this.ctx.storage.get/put/delete/list is the key-value half. ctx.storage.transactionSync(fn) for atomic multi-statement writes. Every event already runs in its own transaction.
- Schema is the code's job, exactly as on Cloudflare: the constructor creates and changes the tables. Keep each step in its own file, migrations/0001_name.sql, import it as text, and run the ones not yet applied:
    import s1 from "../migrations/0001_todos.sql";
    const STEPS: Record<string, string> = { "0001_todos": s1 };
    constructor(ctx, env) {
      super(ctx, env);
      ctx.storage.transactionSync(() => {
        const sql = ctx.storage.sql;
        sql.exec("CREATE TABLE IF NOT EXISTS schema_steps (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
        const done = new Set(sql.exec("SELECT name FROM schema_steps").toArray().map((r) => r.name));
        for (const [name, step] of Object.entries(STEPS)) {
          if (done.has(name)) continue;
          sql.exec(step);
          sql.exec("INSERT INTO schema_steps (name, applied_at) VALUES (?, ?)", name, Date.now());
        }
      });
    }
  Add a step by adding a file and an entry; never edit a step that has been released. The preview is a copy of the live data, so a step that fails on real rows fails there. A step that already ran on the preview does not run again: after changing one, propose with restart: true. A constructor that throws has its writes rolled back. Object code cannot touch _perch_* tables.
- Web pages: files under public/ are static and served before fetch() without waking the object (public/index.html at /, public/about.html at /about, public/docs/index.html at /docs/; /about.html redirects to /about; GET/HEAD only; ETag + 304). Unmatched requests go to fetch(). Binary files (images, fonts) are { "base64": "..." } in propose_change; for a folder of them, import_files reads straight from disk (tens of thousands of files are fine). Templates for dynamic pages can be imported as strings: import page from "./page.html" (also .txt .sql .css .md .svg). The same layout exports to Cloudflare Static Assets unchanged.
- Editing: after the first version, change files with propose_change `edits` (exact old/new string replacement) instead of resending whole files.
- Tests: put tests in test/*.ts. They run on every propose_change and release_change refuses while any fail. Each test gets a fresh, empty copy of the object, whose constructor builds the tables:
    import { test, expect } from "perch:test";
    test("adds an item", async (obj) => {
      const res = await obj.fetch("/todos", { body: { title: "milk" } });   // object body = JSON POST
      expect(res.status).toBe(201);
      expect(await obj.rpc("count")).toEqual({ open: 1, done: 0 });
      obj.clock.advance(8 * 24 * 3600 * 1000);   // Date.now() follows the test clock
      await obj.alarm();
      expect(obj.sql("SELECT count(*) AS n FROM todos")[0].n).toBe(0);
    });
  obj has fetch(path, init), rpc(method, ...args), alarm(), sql(query, ...bindings) for seeding and assertions, storage, and clock.set/advance/now. expect has toBe, toEqual, toBeTruthy, toBeFalsy, toBeNull, toBeDefined, toContain, toHaveLength, toBeGreaterThan, toBeLessThan, toMatch, and .not. Write tests for the behavior the user asked for, so later changes cannot quietly break it.
- Available globals: Request, Response, Headers, URL, URLSearchParams, TextEncoder/TextDecoder, crypto.randomUUID/getRandomValues, setTimeout, structuredClone, atob/btoa, console (logs come back in call results). Not yet: outbound fetch, WebSockets, env bindings, npm imports (relative imports between files in the object work).
- Keep the class Cloudflare-compatible: the same source deploys unchanged with `perch export` + wrangler."#;

fn tools_list() -> Value {
    // Reads and writes are separate tools. The write tools take only unsafe
    // HTTP methods; read_object takes only GET and HEAD and the runtime
    // refuses any write made during it.
    let write_schema = json!({
        "type": "object",
        "properties": {
            "kind": { "type": "string", "enum": ["fetch", "rpc", "alarm"], "description": "fetch: an HTTP write to fetch(); rpc: a public method; alarm: run alarm() now (preview only)" },
            "path": { "type": "string", "description": "fetch: path and query on the object's own fetch() handler, e.g. /todos/123" },
            "http_method": { "type": "string", "enum": ["POST", "PUT", "PATCH", "DELETE"], "default": "POST", "description": "fetch: the HTTP method. GET and HEAD are reads and go through read_object." },
            "headers": { "type": "object", "additionalProperties": { "type": "string" } },
            "body": { "description": "fetch: a string is sent as-is; any other JSON value is sent as application/json" },
            "method": { "type": "string", "description": "rpc: the name of a public method on the object's class" },
            "args": { "type": "array", "description": "rpc: positional arguments (JSON)" },
            "target": { "type": "string", "enum": ["live", "preview"], "default": "live", "description": "live changes the real data; preview changes only the preview copy" }
        },
        "required": ["kind"]
    });
    let read_schema = json!({
        "type": "object",
        "properties": {
            "kind": { "type": "string", "enum": ["fetch", "rpc"], "description": "fetch: a GET or HEAD request to the object's fetch() handler or its public/ files; rpc: a public method" },
            "path": { "type": "string", "description": "fetch: path and query, e.g. /todos?done=0" },
            "http_method": { "type": "string", "enum": ["GET", "HEAD"], "default": "GET" },
            "headers": { "type": "object", "additionalProperties": { "type": "string" } },
            "method": { "type": "string", "description": "rpc: the name of a public method on the object's class" },
            "args": { "type": "array", "description": "rpc: positional arguments (JSON)" },
            "target": { "type": "string", "enum": ["live", "preview"], "default": "live" }
        },
        "required": ["kind"]
    });
    json!([
        {
            "name": "describe_object",
            "title": "Describe object",
            "description": "Name, class, live check-in, recent code history (check-in ids, messages, times), data tables with columns and row counts, code file list, next alarm and preview state. Useful as the first call, to see what the object contains. target \"preview\" describes the preview copy (its schema, data counts and alarm).",
            "inputSchema": { "type": "object", "properties": {
                "target": { "type": "string", "enum": ["live", "preview"], "default": "live" }
            } },
            "annotations": { "title": "Describe object", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "read_code",
            "title": "Read code",
            "description": "Files at a check-in: the live one by default, \"preview\" for the preview head, or a check-in id (prefix of 4+ characters works). Pass path for one file. Text comes back as strings; binary files as { base64 } when asked for by path, otherwise as a size stub. In the full listing, text files over 32 KiB come back as a size stub too; one file by path is returned up to 512 KiB.",
            "inputSchema": { "type": "object", "properties": {
                "checkin": { "type": "string", "description": "check-in id or prefix, or \"preview\"; default live" },
                "path": { "type": "string", "description": "one file, e.g. src/index.ts" }
            } },
            "annotations": { "title": "Read code", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "query_data",
            "title": "Query data",
            "description": "Read-only SQL over the object's own tables (SQLite dialect, see https://sqlite.org/lang_select.html). Reserved _perch_* tables and all writes are refused. target \"preview\" reads the preview copy. At most 500 rows.",
            "inputSchema": { "type": "object", "properties": {
                "sql": { "type": "string" },
                "params": { "type": "array", "description": "positional ? bindings" },
                "target": { "type": "string", "enum": ["live", "preview"], "default": "live" }
            }, "required": ["sql"] },
            "annotations": { "title": "Query data", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "propose_change",
            "title": "Propose change",
            "description": "Change this object's code, static files and stored tests on a preview copy of the file; the live object is not touched until release_change. Takes whole files and exact-string edits, applies them to the preview (a copy of the live file, data included), builds it (the module graph loads and the constructor runs, which is where the code creates or changes its tables) and runs the stored tests. Code is TypeScript against the Cloudflare Durable Objects API (https://developers.cloudflare.com/durable-objects/api/). Repeated proposals stack on the current preview; restart: true discards the preview and starts over from live. from_checkin starts from an earlier check-in's files, which is how code is rolled back.",
            "inputSchema": { "type": "object", "properties": {
                "message": { "type": "string", "description": "what this change does" },
                "files": { "type": "object", "additionalProperties": { "anyOf": [
                    { "type": "string", "description": "text contents" },
                    { "type": "object", "properties": { "base64": { "type": "string" } }, "required": ["base64"], "description": "binary contents (images, fonts) for public/" },
                    { "type": "null", "description": "delete the file" }
                ] }, "description": "path -> full file contents. Code lives under src/, schema steps under migrations/, tests under test/; files under public/ are served as-is at the matching URL path." },
                "edits": { "type": "array", "description": "exact-string replacements in existing text files, applied after `files`. Prefer these over resending a whole file.", "items": { "type": "object", "properties": {
                    "path": { "type": "string" },
                    "old": { "type": "string", "description": "text to replace; must match exactly and occur once (unless replace_all)" },
                    "new": { "type": "string" },
                    "replace_all": { "type": "boolean", "default": false }
                }, "required": ["path", "old", "new"] } },
                "from_checkin": { "type": "string", "description": "start from the files of this earlier check-in (id or 4+ character prefix, from describe_object) instead of the live ones; discards the current preview" },
                "restart": { "type": "boolean", "default": false, "description": "discard the current preview and start from live" }
            }, "required": ["message"] },
            "annotations": { "title": "Propose change", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": false }
        },
        {
            "name": "read_object",
            "title": "Read from object",
            "description": "Read from this object without changing it: a GET or HEAD to the object's own fetch() handler or its public/ files, or a call to one of its public RPC methods (the routes and methods are the ones read_code shows). The runtime enforces the read: any SQL write, key-value write or alarm change made during the call is refused with an error and nothing is saved. target \"preview\" reads the preview copy. Use it to view pages and call getters.",
            "inputSchema": read_schema,
            "annotations": { "title": "Read from object", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "import_files",
            "title": "Import static files",
            "description": "Import a directory of static files (images, fonts, documents) from this machine's disk into the live object's public/ tree, as one check-in. The files stream from disk, so tens of thousands are fine and none pass through this conversation: give the directory path. Files already present with the same contents are skipped, so a repeat run is cheap. Changes the live object directly (static files cannot change what the class does); refused while a preview is unreleased. For code, tests and a few small files, use propose_change.",
            "inputSchema": { "type": "object", "properties": {
                "dir": { "type": "string", "description": "absolute path of the directory to read, recursively" },
                "into": { "type": "string", "default": "public/", "description": "where the files go inside the object; must be under public/, e.g. public/img/" },
                "prune": { "type": "boolean", "default": false, "description": "also remove files under `into` that the directory does not have" },
                "message": { "type": "string", "description": "check-in message" }
            }, "required": ["dir"] },
            "annotations": { "title": "Import static files", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "release_change",
            "title": "Release change",
            "description": "Make the preview's code live, squashed into one check-in, and start it on the live data (its constructor runs, applying any schema steps). Refused if the preview did not build, a stored test fails, or live moved since the preview was made. If the new code does not start on the live data, the release is undone and live keeps the code it had.",
            "inputSchema": { "type": "object", "properties": {
                "message": { "type": "string", "description": "release message; defaults to the preview check-in messages" }
            } },
            "annotations": { "title": "Release change", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": false }
        },
        {
            "name": "call_object",
            "title": "Call object",
            "description": "Make a write call on this object: a POST, PUT, PATCH or DELETE to the object's own fetch() handler, or one of its public RPC methods (the routes and methods are the ones read_code shows). target \"live\" (the default) changes live data; target \"preview\" changes only the preview copy, and there kind \"alarm\" runs alarm() now (clearing the pending alarm unless the handler rescheduled it). Returns the result, console logs, rows written and the next alarm. For reads, use read_object.",
            "inputSchema": write_schema,
            "annotations": { "title": "Call object", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": false }
        }
    ])
}

async fn call_tool(tools: &mut Tools, name: &str, args: Value) -> Result<Value> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    match name {
        "describe_object" => tools.describe(s("target").as_deref()),
        "read_code" => tools.read_code(s("checkin").as_deref(), s("path").as_deref()),
        "query_data" => {
            let sql = s("sql").ok_or_else(|| anyhow::anyhow!("sql is required"))?;
            let params: Vec<Value> = args.get("params").and_then(|v| v.as_array().cloned()).unwrap_or_default();
            tools.query_data(&sql, &params, s("target").as_deref())
        }
        "propose_change" => tools.propose_change(serde_json::from_value::<ProposeArgs>(args)?).await,
        "read_object" => {
            let target = s("target");
            tools.read_object(serde_json::from_value::<CallArgs>(args)?, target.as_deref()).await
        }
        "import_files" => {
            let dir = s("dir").ok_or_else(|| anyhow::anyhow!("dir is required"))?;
            let prune = args.get("prune").and_then(|v| v.as_bool()).unwrap_or(false);
            tools.import_files(std::path::Path::new(&dir), s("into").as_deref(), s("message"), prune, &mut |_| {})
        }
        "release_change" => tools.release_change(s("message")).await,
        "call_object" => {
            let target = s("target");
            tools.call_object(serde_json::from_value::<CallArgs>(args)?, target.as_deref()).await
        }
        other => anyhow::bail!("unknown tool {other}"),
    }
}

pub async fn serve(path: PathBuf) -> Result<()> {
    let mut tools = Tools::new(path)?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let r = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": e.to_string() } });
                out.write_all(format!("{r}\n").as_bytes()).await?;
                out.flush().await?;
                continue;
            }
        };
        let Some(id) = msg.get("id").cloned() else {
            continue; // notification
        };
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        let result: std::result::Result<Value, (i64, String)> = match method {
            "initialize" => {
                let asked = params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or(PROTOCOL_VERSIONS[0]);
                let v = if PROTOCOL_VERSIONS.contains(&asked) { asked } else { PROTOCOL_VERSIONS[0] };
                Ok(json!({
                    "protocolVersion": v,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "perch", "title": "Portable Durable Object", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": GUIDE,
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools_list() })),
            "tools/call" => {
                let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                match call_tool(&mut tools, &name, args).await {
                    Ok(v) => {
                        let is_error = v.get("ok").and_then(|o| o.as_bool()) == Some(false)
                            || v.pointer("/build/ok").and_then(|o| o.as_bool()) == Some(false)
                            || v.pointer("/tests/ok").and_then(|o| o.as_bool()) == Some(false);
                        Ok(json!({
                            "content": [{ "type": "text", "text": serde_json::to_string(&v).unwrap() }],
                            "structuredContent": v,
                            "isError": is_error,
                        }))
                    }
                    Err(e) => Ok(json!({
                        "content": [{ "type": "text", "text": format!("{e:#}") }],
                        "isError": true,
                    })),
                }
            }
            _ => Err((-32601, format!("method not found: {method}"))),
        };
        let resp = match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        };
        out.write_all(format!("{resp}\n").as_bytes()).await?;
        out.flush().await?;
    }
    Ok(())
}
