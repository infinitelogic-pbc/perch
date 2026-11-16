//! MCP over stdio (JSON-RPC 2.0, one message per line). One fixed tool set for
//! every object; the object file is chosen on the command line.

use std::path::PathBuf;

use anyhow::Result;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::tools::{CallArgs, ProposeArgs, Tools};

const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

pub const GUIDE: &str = r#"This server edits one portable durable object: a single SQLite file holding a Cloudflare-style Durable Object's code, history and data.

Workflow: describe_object → read_code → propose_change (code + tests + migrations, applied to a preview copy, built there, stored tests run) → test_call (try it against the preview) → release_change (refused if tests fail; runs the migrations on the live file and moves the live check-in). rollback_code moves code back if it still fits the schema. undo_changes reverses recent data changes. call_object hits the live object.

Writing the object:
- The entry file is src/index.ts. It exports the object's class (the name describe_object reports) extending DurableObject from "cloudflare:workers". Constructor signature is (ctx, env); call super(ctx, env).
- Handlers: async fetch(request: Request): Promise<Response>; public methods are RPC (callable over HTTP as POST /.pdo/rpc/<method> with a JSON array of args); async alarm() runs when ctx.storage.setAlarm(epochMs) comes due.
- Storage: this.ctx.storage.sql.exec(sql, ...bindings) returns a cursor (.toArray(), .one(), .raw(), rowsWritten). this.ctx.storage.get/put/delete/list is the key-value half. ctx.storage.transactionSync(fn) for atomic multi-statement writes. Every event already runs in its own transaction.
- Schema changes go ONLY in propose_change migrations (ordered, forward-only SQL). Object code cannot CREATE/ALTER/DROP, and cannot touch _obj_* tables.
- Data tables need a declared PRIMARY KEY; use UUIDv7 TEXT keys (crypto.randomUUID() is v4; build v7 from Date.now() + crypto.getRandomValues) rather than INTEGER/AUTOINCREMENT so copies of the file can merge changesets later.
- Web pages: files under public/ are static and served before fetch() without waking the object (public/index.html at /, public/about.html at /about, public/docs/index.html at /docs/; /about.html redirects to /about; GET/HEAD only; ETag + 304). Unmatched requests go to fetch(). Binary files (images, fonts) are { "base64": "..." } in propose_change. Templates for dynamic pages can be imported as strings: import page from "./page.html" (also .txt .sql .css .md .svg). The same layout exports to Cloudflare Static Assets unchanged.
- Editing: after the first version, change files with propose_change `edits` (exact old/new string replacement) instead of resending whole files.
- Tests: put tests in test/*.ts. They run on every propose_change and release_change refuses while any fail. Each test gets a fresh, empty copy of the object:
    import { test, expect } from "pdo:test";
    test("adds an item", async (obj) => {
      const res = await obj.fetch("/todos", { body: { title: "milk" } });   // object body = JSON POST
      expect(res.status).toBe(201);
      expect(await obj.rpc("count")).toEqual({ open: 1, done: 0 });
      obj.clock.advance(8 * 24 * 3600 * 1000);   // Date.now() follows the test clock
      await obj.alarm();
      expect(obj.sql("SELECT count(*) AS n FROM todos")[0].n).toBe(0);
    });
  obj has fetch(path, init), rpc(method, ...args), alarm(), sql(query, ...bindings) for seeding and assertions, storage, and clock.set/advance/now. expect has toBe, toEqual, toBeTruthy, toBeFalsy, toBeNull, toBeDefined, toContain, toHaveLength, toBeGreaterThan, toBeLessThan, toMatch, and .not. Write tests for the behavior the user asked for, so later changes cannot quietly break it.
- Undo: every write is recorded. list_changes shows recent data changes; undo_changes reverses them (not across a migration).
- Available globals: Request, Response, Headers, URL, URLSearchParams, TextEncoder/TextDecoder, crypto.randomUUID/getRandomValues, setTimeout, structuredClone, atob/btoa, console (logs come back in test_call). Not yet: outbound fetch, WebSockets, env bindings, npm imports (relative imports between files in the object work).
- Keep the class Cloudflare-compatible: the same source deploys unchanged with `pdo export` + wrangler."#;

fn tools_list() -> Value {
    let call_schema = json!({
        "type": "object",
        "properties": {
            "kind": { "type": "string", "enum": ["fetch", "rpc", "alarm"], "description": "fetch: an HTTP request to fetch(); rpc: a public method; alarm: run alarm() now" },
            "path": { "type": "string", "description": "fetch: path and query, e.g. /todos?done=0" },
            "http_method": { "type": "string", "description": "fetch: GET, POST, PUT, PATCH, DELETE (default GET, or POST when a body is given)" },
            "headers": { "type": "object", "additionalProperties": { "type": "string" } },
            "body": { "description": "fetch: a string is sent as-is; any other JSON value is sent as application/json" },
            "method": { "type": "string", "description": "rpc: the method name" },
            "args": { "type": "array", "description": "rpc: positional arguments (JSON)" }
        },
        "required": ["kind"]
    });
    json!([
        {
            "name": "describe_object",
            "title": "Describe object",
            "description": "Name, class, live check-in, data tables with columns and row counts, code file list, next alarm and preview state. Start here. target \"preview\" describes the preview copy (its schema, data counts and alarm).",
            "inputSchema": { "type": "object", "properties": {
                "target": { "type": "string", "enum": ["live", "preview"], "default": "live" }
            } },
            "annotations": { "title": "Describe object", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "read_code",
            "title": "Read code",
            "description": "Files at a check-in: the live one by default, \"preview\" for the preview head, or a check-in id (prefix of 4+ characters works). Pass path for one file. Text comes back as strings; binary files as { base64 } when asked for by path, otherwise as a size stub.",
            "inputSchema": { "type": "object", "properties": {
                "checkin": { "type": "string", "description": "check-in id or prefix, or \"preview\"; default live" },
                "path": { "type": "string", "description": "one file, e.g. src/index.ts" }
            } },
            "annotations": { "title": "Read code", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "list_checkins",
            "title": "List check-ins",
            "description": "Code history, newest first, with unified diffs against each parent and the migrations each check-in added.",
            "inputSchema": { "type": "object", "properties": {
                "limit": { "type": "integer", "minimum": 1, "default": 20 },
                "diffs": { "type": "boolean", "default": true }
            } },
            "annotations": { "title": "List check-ins", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "query_data",
            "title": "Query data",
            "description": "Read-only SQL over the object's own tables (SQLite dialect, see https://sqlite.org/lang_select.html). Reserved _obj_* tables and all writes are refused. target \"preview\" reads the preview copy after a test_call. At most 500 rows.",
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
            "description": "Code edits plus new migrations, applied to a preview copy of the file (live data included) and built there: the module graph loads and the constructor runs. Repeated proposals stack on the current preview; restart: true starts over from live. Files map path to full new contents (null deletes). Migrations are forward-only SQL, run in order, each with a name.",
            "inputSchema": { "type": "object", "properties": {
                "message": { "type": "string", "description": "what this change does" },
                "files": { "type": "object", "additionalProperties": { "anyOf": [
                    { "type": "string", "description": "text contents" },
                    { "type": "object", "properties": { "base64": { "type": "string" } }, "required": ["base64"], "description": "binary contents (images, fonts) for public/" },
                    { "type": "null", "description": "delete the file" }
                ] }, "description": "path -> full file contents. Code lives under src/; files under public/ are served as-is at the matching URL path." },
                "edits": { "type": "array", "description": "exact-string replacements in existing text files, applied after `files`. Prefer these over resending a whole file.", "items": { "type": "object", "properties": {
                    "path": { "type": "string" },
                    "old": { "type": "string", "description": "text to replace; must match exactly and occur once (unless replace_all)" },
                    "new": { "type": "string" },
                    "replace_all": { "type": "boolean", "default": false }
                }, "required": ["path", "old", "new"] } },
                "migrations": { "type": "array", "items": { "type": "object", "properties": {
                    "name": { "type": "string" }, "sql": { "type": "string" }
                }, "required": ["name", "sql"] } },
                "restart": { "type": "boolean", "default": false, "description": "discard the current preview and start from live" }
            }, "required": ["message"] },
            "annotations": { "title": "Propose change", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false }
        },
        {
            "name": "test_call",
            "title": "Test call (preview)",
            "description": "Call fetch, an RPC method or the alarm on the preview copy and return the result, console logs, the rows each table gained, changed or lost, and the preview's next alarm afterwards. Writes land in the preview only. An alarm run here clears the pending alarm unless the handler rescheduled it.",
            "inputSchema": call_schema.clone(),
            "annotations": { "title": "Test call (preview)", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false }
        },
        {
            "name": "run_tests",
            "title": "Run stored tests",
            "description": "Run the object's test/*.ts files. Each test gets its own fresh, empty copy of the object (same code, all migrations, no data) and a controllable clock, so results never depend on live data. Runs the preview's tests when a preview exists, else live's. propose_change runs these automatically and release_change refuses while any fail.",
            "inputSchema": { "type": "object", "properties": {
                "target": { "type": "string", "enum": ["preview", "live"], "description": "default: preview if one exists, else live" }
            } },
            "annotations": { "title": "Run stored tests", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "list_changes",
            "title": "List data changes",
            "description": "Recent data changes on the live object, newest first: which event made each (fetch, rpc, alarm, migration, undo), when, and rows inserted, updated and deleted per table. Shows which can be undone.",
            "inputSchema": { "type": "object", "properties": {
                "limit": { "type": "integer", "minimum": 1, "default": 20 }
            } },
            "annotations": { "title": "List data changes", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "undo_changes",
            "title": "Undo data changes",
            "description": "Reverse the live data change with this id and every newer one, in one transaction, restoring rows and KV values to what they were before. Refused across a migration. The undo is recorded as a change itself, so it can be undone.",
            "inputSchema": { "type": "object", "properties": {
                "back_to": { "type": "integer", "description": "id from list_changes; this change and all newer ones are reversed" }
            }, "required": ["back_to"] },
            "annotations": { "title": "Undo data changes", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": false }
        },
        {
            "name": "release_change",
            "title": "Release change",
            "description": "Run the preview's migrations on the live file and move the live check-in to the preview's code, squashed into one check-in, in one transaction. Refused if the preview did not build or live moved since it was made.",
            "inputSchema": { "type": "object", "properties": {
                "message": { "type": "string", "description": "release message; defaults to the preview check-in messages" }
            } },
            "annotations": { "title": "Release change", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": false }
        },
        {
            "name": "rollback_code",
            "title": "Roll back code",
            "description": "Move the live check-in back to an earlier one. Code only, never schema: refused when that code expects tables or columns that no longer match, or when a column it does not know about is NOT NULL without a default.",
            "inputSchema": { "type": "object", "properties": {
                "checkin": { "type": "string", "description": "check-in id or prefix (4+ characters)" }
            }, "required": ["checkin"] },
            "annotations": { "title": "Roll back code", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "call_object",
            "title": "Call object (live)",
            "description": "Call fetch or an RPC method on the live object. Writes change live data.",
            "inputSchema": call_schema,
            "annotations": { "title": "Call object (live)", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": false }
        }
    ])
}

async fn call_tool(tools: &mut Tools, name: &str, args: Value) -> Result<Value> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    match name {
        "describe_object" => tools.describe(s("target").as_deref()),
        "read_code" => tools.read_code(s("checkin").as_deref(), s("path").as_deref()),
        "list_checkins" => tools.list_checkins(
            args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize,
            args.get("diffs").and_then(|v| v.as_bool()).unwrap_or(true),
        ),
        "query_data" => {
            let sql = s("sql").ok_or_else(|| anyhow::anyhow!("sql is required"))?;
            let params: Vec<Value> = args.get("params").and_then(|v| v.as_array().cloned()).unwrap_or_default();
            tools.query_data(&sql, &params, s("target").as_deref())
        }
        "propose_change" => tools.propose_change(serde_json::from_value::<ProposeArgs>(args)?).await,
        "test_call" => tools.test_call(serde_json::from_value::<CallArgs>(args)?).await,
        "run_tests" => tools.run_tests(s("target").as_deref()).await,
        "list_changes" => tools.list_changes(args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize),
        "undo_changes" => {
            let id = args.get("back_to").and_then(|v| v.as_i64()).ok_or_else(|| anyhow::anyhow!("back_to is required"))?;
            tools.undo_changes(id)
        }
        "release_change" => tools.release_change(s("message")).await,
        "rollback_code" => {
            let c = s("checkin").ok_or_else(|| anyhow::anyhow!("checkin is required"))?;
            tools.rollback_code(&c)
        }
        "call_object" => {
            let c: CallArgs = serde_json::from_value(args)?;
            if c.kind == "alarm" {
                anyhow::bail!("call_object takes fetch or rpc; alarms fire on schedule (pdo run), or use test_call on the preview");
            }
            tools.call_object(c).await
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
                    "serverInfo": { "name": "pdo", "title": "Portable Durable Object", "version": env!("CARGO_PKG_VERSION") },
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
                            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&v).unwrap() }],
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
