# pdo: portable durable objects

A portable durable object is one SQLite file holding both a Durable Object's
data and its code. `pdo` opens the file and runs it like a Cloudflare Durable
Object, on a laptop, a server or anywhere else, and exposes an MCP wrapper so
an agent can build and change the object without a separate dev environment.

```
pdo new todo.obj --class Todo          # empty class, or --from <dir> with src/ + migrations/
pdo mcp todo.obj                       # MCP over stdio: the agent builds it
pdo run todo.obj --port 8787           # serve HTTP, fire alarms
pdo call todo.obj stats                # RPC from the shell
pdo fetch todo.obj /todos              # one request to fetch()
pdo describe todo.obj                  # tables, code, live check-in, next alarm
pdo checkins todo.obj --diffs          # code history
pdo export todo.obj out/ && (cd out && bunx wrangler deploy)
```

Build: `cargo build --release` (V8 comes prebuilt through `deno_core`).

## The file

| Table | Holds |
| --- | --- |
| `_obj_meta` | name, class, entry file, format version (1), runtime API version, the live check-in |
| `_obj_blobs` | content-addressed bytes (SHA-256 → contents): source files |
| `_obj_checkins` | code history, Fossil style: id (SHA-256), parent, manifest (path → blob), message, time, schema snapshot |
| `_obj_migrations` | ordered SQL migrations already applied, each tied to the check-in that introduced it |
| `_obj_kv` | the key-value half of the storage API (values are V8 structured-clone bytes) |
| `_obj_alarms` | the next scheduled alarm and its retry count |
| `_obj_changes` | a session-extension changeset for every event that wrote data (audit log, later undo and sync) |
| everything else | the object's data, created and changed only by migrations |

A SQLite authorizer enforces the boundary by mode. Object code (`ctx.storage.sql`)
reads and writes data tables only: no `_obj_` tables, no DDL, no
`BEGIN`/`SAVEPOINT`, no `ATTACH`, only introspection pragmas. Migrations may run
DDL on data tables and never touch `_obj_` tables. `query_data` is read-only.
Only the runtime and the MCP wrapper write reserved tables.

Data tables need a declared primary key (the session extension records nothing
without one, and two copies must never mint the same key). `AUTOINCREMENT` is
refused; a single `INTEGER PRIMARY KEY` gets a warning. Use UUIDv7 text.

The file runs in WAL mode so `pdo run` and `pdo mcp` can share it, and every
commit checkpoints the WAL back into the main file, so copying the `.obj`
alone carries the object.

## The runtime

`pdo run` loads the class at the live check-in into one V8 isolate and runs
events one at a time. Each event (constructor, `fetch`, an RPC call, `alarm`)
is one SQLite transaction with a session attached; its changeset goes into
`_obj_changes` before commit. Writes made before a handler throws are kept, as
on Cloudflare. When the live check-in moves (a release or rollback from another
process), the next event rebuilds the isolate and reruns the constructor.

| Capability | API | v0 |
| --- | --- | --- |
| HTTP | `fetch(request)` | yes |
| RPC | public methods; over HTTP as `POST /.pdo/rpc/<method>` with a JSON array of args | yes |
| SQL storage | `ctx.storage.sql.exec` (cursor: `toArray`, `one`, `raw`, `rowsRead`, `rowsWritten`) | yes |
| KV storage | `ctx.storage.get/put/delete/list/deleteAll` | yes |
| Transactions | `ctx.storage.transactionSync`, `ctx.storage.transaction` | yes |
| Alarms | `setAlarm/getAlarm/deleteAlarm` + `alarm({ retryCount, isRetry })`, retried with backoff up to six times | yes |
| Startup | `ctx.blockConcurrencyWhile` (awaited before the first event) | yes |
| Globals | `Request`, `Response`, `Headers`, `URL`, `URLSearchParams`, `TextEncoder/Decoder`, `crypto.randomUUID/getRandomValues`, timers, `structuredClone`, `atob/btoa`, `console` | yes |
| Modules | TypeScript and JS files inside the object (relative imports), `cloudflare:workers` | yes |
| WebSockets and hibernation | | later |
| Bindings (other objects, secrets, outbound fetch) | `fetch` throws for now | later |

Each event has a 30 s wall-clock limit.

## The MCP wrapper

`pdo mcp todo.obj` serves one fixed tool set for every object, each with a
title and annotations; reads and writes are separate tools. The `initialize`
result carries a short guide to writing an object.

| Tool | Annotation | Does |
| --- | --- | --- |
| `describe_object` | readOnly | name, class, live check-in, tables + columns + row counts, files, next alarm, preview state |
| `read_code` | readOnly | files at a check-in (live, `preview`, or an id prefix) |
| `list_checkins` | readOnly | history with unified diffs and the migrations each check-in added |
| `query_data` | readOnly | read-only SQL over data tables, live or preview, 500 rows max |
| `propose_change` | write | code edits + new migrations applied to a preview copy (`todo.obj.preview`, live data included) and built there: modules load and the constructor runs. Proposals stack; `restart: true` starts from live |
| `test_call` | write | fetch, RPC or alarm on the preview; returns the result, logs and rows changed per table |
| `release_change` | destructive | runs the preview's migrations on live and moves the live check-in, squashed into one check-in, in one transaction; refused if the preview did not build or live moved |
| `rollback_code` | destructive | moves the live check-in back; refused when that code's schema snapshot no longer fits (a table or column it knew is gone, or a new NOT NULL column has no default) |
| `call_object` | destructive | fetch or RPC on the live object |

Migrations only go forward; a rollback changes code, never schema.

## Cloudflare

`pdo export todo.obj out/` writes the live check-in's files unchanged plus a
generated `pdo/worker.js` and `wrangler.jsonc`. The wrapper class applies the
object's migrations once per object (tracked in `_pdo_migrations`), forwards
`fetch` and `alarm` to the original class, and the entry worker gives the same
HTTP surface as `pdo run` (`POST /.pdo/rpc/<method>`). Moving state in or out
of Cloudflare is not in v0.

## Tests

- `bun test/e2e.ts` builds the to-do example entirely through the MCP tools,
  probes the sandbox, serves it, fires the alarm, releases a bad change and
  rolls it back under a running server, checks that a rollback across a
  breaking migration is refused, and serves a copy of the file (49 checks).
- `bun test/http-calls.ts <base>` runs the same 11 HTTP calls against any host;
  it passes against `pdo run` and against the `pdo export` deploy on Cloudflare.

## Not yet

WebSockets, bindings, a server mode hosting a directory of objects, sync
between copies (the changesets are recorded for it), moving state to or from
Cloudflare, and a lease so only one copy is live. `pdo run` and `pdo mcp` on
the same file each hold their own isolate; in-memory fields on the class are
per process, and only `pdo run` fires alarms. `pdo` and `.obj` are working
names.

Related: celld (self-hosted Workers and Durable Objects) and Rivet Actors.
