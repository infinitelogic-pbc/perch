# pdo: portable durable objects

A portable durable object is one SQLite file holding both a Durable Object's
data and its code. `pdo` opens the file and runs it like a Cloudflare Durable
Object, on a laptop, a server or anywhere else, and exposes an MCP wrapper so
an agent can build and change the object without a separate dev environment.

## Quick start

Build once (V8 comes prebuilt through `deno_core`):

```sh
cd pdo && cargo build --release
```

Then point `bin/pdo-claude` at an object file. It opens a Claude session in a
fresh, empty temp directory with only that object's MCP tools attached, and
creates the object first if the file does not exist:

```sh
bin/pdo-claude ~/objects/my.obj                 # new or existing object
bin/pdo-claude ~/objects/shop.obj --class Shop  # class name for a new one
bin/pdo-claude my.obj -- --model sonnet "build a guestbook"   # args after -- go to claude
```

A new object is an empty class (`export class My extends DurableObject {}`)
with no tables and no data. Tell Claude what to build; it proposes code,
tests and migrations, tries them on a preview copy and releases. In a second
terminal, serve it while you work:

```sh
target/release/pdo run ~/objects/my.obj              # http://127.0.0.1:8787, reloads on every release
target/release/pdo checkins ~/objects/my.obj --diffs # what the agent changed
```

The helper finds the binary at `$PDO`, then this checkout's
`target/release/pdo`, then `pdo` on `PATH`, and removes the temp directory
when Claude exits. The object file stays where you put it.

## Commands

```
pdo new my.obj --class Obj             # empty class, or --from <dir> with src/ + migrations/
pdo mcp my.obj                         # MCP over stdio: the agent builds it
pdo run my.obj --port 8787             # serve HTTP, fire alarms
pdo call my.obj <method> '[args]'      # RPC from the shell
pdo fetch my.obj /path                 # one request to fetch()
pdo describe my.obj                    # tables, code, live check-in, next alarm
pdo checkins my.obj --diffs            # code history
pdo test my.obj                        # stored tests, each on a fresh empty copy
pdo changes my.obj                     # recent data changes
pdo undo my.obj <id>                   # reverse that change and every newer one
pdo export my.obj out/ && (cd out && bunx wrangler deploy)
```

`examples/todo` is a finished object to import (`pdo new todo.obj --class Todo --from examples/todo`).

## The file

| Table | Holds |
| --- | --- |
| `_obj_meta` | name, class, entry file, format version (1), runtime API version, the live check-in |
| `_obj_blobs` | content-addressed bytes (SHA-256 → contents): source files |
| `_obj_checkins` | code history, Fossil style: id (SHA-256), parent, manifest (path → blob), message, time, schema snapshot |
| `_obj_migrations` | ordered SQL migrations already applied, each tied to the check-in that introduced it |
| `_obj_kv` | the key-value half of the storage API. Values are UTF-8 JSON that any runtime can read; what plain JSON cannot carry (Date, Map, Set, bytes, bigint, undefined, NaN) is tagged with `$pdo`. Values written before this in V8's own format are still read by the native binary |
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
| Text imports | `import page from "./page.html"` gives the file as a string (`.html` `.txt` `.sql` `.css` `.md` `.svg`) | yes |
| Static files | everything under `public/`, served before `fetch()` (see below) | yes |
| WebSockets and hibernation | | later |
| Bindings (other objects, secrets, outbound fetch) | `fetch` throws for now | later |

Each event has a 30 s wall-clock limit.

## Web pages

Files under `public/` are served as-is at the matching URL path, before
`fetch()`, and without waking the object: a static file is a lookup in
`_obj_blobs` with no constructor, no transaction and no changeset. A class
that fails to load still serves its static files.

The rules are Cloudflare Workers Static Assets' defaults, so a page behaves
the same under `pdo run` and after `pdo export`:

| Request | Result |
| --- | --- |
| `/` | `public/index.html` |
| `/about` | `public/about.html` |
| `/about.html` | 307 to `/about` |
| `/docs` | 307 to `/docs/` (when `public/docs/index.html` exists) |
| `/docs/` | `public/docs/index.html` |
| `/docs/index.html` | 307 to `/docs/` |
| `/css/site.css` | `public/css/site.css` |
| anything else, or any method but GET/HEAD | `fetch()` (a 404 when the class has none) |

Responses carry a content type by extension, the file's SHA-256 as a strong
`ETag` (so `If-None-Match` gets a 304), and
`Cache-Control: public, max-age=0, must-revalidate`. Binary files (images,
fonts) go through `propose_change` as `{ "base64": "..." }`; files are limited
to 25 MiB each, Cloudflare's per-asset limit. Dynamic pages render in `fetch()`,
usually from an imported template (`examples/todo` serves its UI from
`public/` and renders `/stats` from `src/stats.html`).

## The MCP wrapper

`pdo mcp todo.obj` serves one fixed tool set for every object, each with a
title and annotations; reads and writes are separate tools. The `initialize`
result carries a short guide to writing an object.

| Tool | Annotation | Does |
| --- | --- | --- |
| `describe_object` | readOnly | name, class, live check-in, tables + columns + row counts, files, next alarm, preview state |
| `read_code` | readOnly | files at a check-in (live, `preview`, or an id prefix); binary as `{ base64 }` by path |
| `list_checkins` | readOnly | history and the migrations each check-in added; unified diffs on request |
| `query_data` | readOnly | read-only SQL over data tables, live or preview, 500 rows max |
| `propose_change` | destructive | whole files, `edits` (exact old/new string replacements) and new migrations, applied to a preview copy (`todo.obj.preview`, live data included) and built there: modules load, the constructor runs, stored tests run. Proposals stack; `restart: true` starts from live |
| `test_call` | destructive | a write call on the preview: POST/PUT/PATCH/DELETE to fetch(), an RPC method, or alarm(); returns the result, logs and rows changed per table |
| `read_object` | readOnly | a read of live or the preview: GET/HEAD to fetch() or `public/`, or an RPC method. Enforced by the runtime: any SQL write, KV write or alarm change is refused and the transaction is rolled back |
| `run_tests` | readOnly | runs `test/*.ts`, each test on its own fresh empty copy of the object |
| `list_changes` | readOnly | recent data changes on live: event, time, rows per table, whether undoable |
| `undo_changes` | destructive | reverses a data change and every newer one in one transaction; refused across a migration; recorded, so it can be undone |
| `release_change` | destructive | runs the preview's migrations on live and moves the live check-in, squashed into one check-in, in one transaction; refused if the preview did not build, a stored test fails, or live moved |
| `rollback_code` | destructive | moves the live check-in back; refused when that code's schema snapshot no longer fits (a table or column it knew is gone, or a new NOT NULL column has no default) |
| `call_object` | destructive | a write call on the live object: POST/PUT/PATCH/DELETE to fetch(), or an RPC method |

Migrations only go forward; a rollback changes code, never schema.

## The harness is in the file

There is no separate dev environment: the artifact is the workspace, the
runtime is the sandbox, and the MCP tools are the harness. Three pieces make
that efficient for agents and safe for people who never see the code.

**Edits.** After the first version, `propose_change` takes
`edits: [{ path, old, new }]`: `old` must match the file exactly and occur once
(or set `replace_all`). A one-line fix costs one line.

**Stored tests.** Tests live in the object under `test/` and travel with it.
They run on every proposal, and `release_change` refuses while any fail; there
is no override. Each test gets its own fresh, empty copy of the object (same
code, every migration replayed, no data), so results never depend on live
data, and a clock it controls:

```ts
import { test, expect } from "pdo:test";

test("cleanup removes items done for over a day", async (obj) => {
  const item = await obj.rpc("add", "old");          // public methods, as RPC
  await obj.rpc("setDone", item.id, true);
  obj.clock.advance(2 * 24 * 60 * 60 * 1000);        // Date.now() follows it
  await obj.alarm();                                 // run alarm() now
  expect(obj.sql("SELECT count(*) AS n FROM todos")[0].n).toBe(0);
  const res = await obj.fetch("/todos", { body: { title: "x" } });  // JSON POST
  expect(res.status).toBe(201);
});
```

`obj` has `fetch`, `rpc`, `alarm`, `sql` (seeding and assertions), `storage`
and `clock.set/advance/now`. `expect` has `toBe`, `toEqual`, `toBeTruthy`,
`toBeFalsy`, `toBeNull`, `toBeDefined`, `toContain`, `toHaveLength`,
`toBeGreaterThan`, `toBeLessThan`, `toMatch` and `.not`. `pdo test my.obj`
runs them from the shell (exit 1 on failure); `examples/todo/test` has seven.

**Data undo.** Every event's changeset is already in `_obj_changes`.
`list_changes` shows them; `undo_changes { back_to }` inverts that change and
every newer one, newest first, in one transaction, restoring rows and KV
values (alarms are not restored). It aborts untouched if a change no longer
applies cleanly, is refused across a migration, and is recorded as a change
itself, so an undo can be undone. A running `pdo run` rebuilds its isolate on
the next event so in-memory state matches. From the shell: `pdo changes`,
`pdo undo my.obj <id>`.

## Claude connector directory rules

The tool set follows Anthropic's
[connector review criteria](https://claude.com/docs/connectors/building/review-criteria)
and [Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy),
checked by the end-to-end suite:

| Rule | How pdo meets it |
| --- | --- |
| Every tool has a `title` and `readOnlyHint: true` or `destructiveHint: true` | All thirteen do, exactly one each. Seven are read-only; the six that modify anything (including the preview copy) are destructive |
| No tool accepts both safe and unsafe HTTP methods | `read_object` takes only GET and HEAD; `test_call` and `call_object` take only POST, PUT, PATCH and DELETE, and each refuses the other's methods with the name of the right tool |
| Read-only means read-only | `read_object` and `query_data` are enforced by the SQLite authorizer and the runtime, not by convention: writes error and nothing is saved |
| Freeform tools name their target API | `query_data` and migrations link the SQLite docs; `propose_change` links the Cloudflare Durable Objects API; the call tools name the object's own `fetch()` routes and public methods |
| Tool names are 64 characters or fewer | The longest is 15 |
| Descriptions say what the tool does, and match it | No instructions to call other software, no behavior outside the tool |
| Errors are actionable | Refusals say why and what to do instead; no bare "Bad Request" |
| Responses are sized to the task | `list_checkins` leaves diffs out unless asked; `read_code` stubs large and binary files in the full listing and caps one file at 512 KiB; `query_data` returns at most 500 rows; tool text is compact JSON |
| No conversation data collected | pdo stores only what tools are asked to store |

What a directory submission still needs, beyond the tools:

- **A remote server.** The directory accepts only remote MCP servers over
  HTTPS (Streamable HTTP), with OAuth 2.0 when sign-in is needed. `pdo mcp` is
  local stdio today, so it can be listed only inside a plugin until there is a
  hosted pdo (the server mode on the not-yet list, plus HTTP transport and
  OAuth).
- **Listing materials:** a public documentation URL, a privacy policy URL, a
  support contact, an icon, at least three example prompts, and a test account
  for review.

## Privacy

`pdo` runs on your machine. It has no telemetry and makes no network requests
of its own. An object's code and data live in its `.obj` file and nowhere
else; object code cannot make outbound requests (`fetch` throws in v0). The
MCP server speaks only over stdio to the client that started it, and stores
only what its tools are asked to store. Data leaves the machine only when you
send it: `pdo export` followed by `wrangler deploy` uploads the object's code,
static files and migrations (not its data) to your Cloudflare account, and
`pdo run --host` exposes the object on the network interface you choose.

## Direction

The next layer is a framework class that lives in an object and turns it into
an app described as data, so agents configure more and code less. Its default
interface is a spreadsheet: **tables** are the typed view of the database, and
**sheets** are the UIs built on those tables. pdo stays the low-level layer
underneath.

## In the browser

The same file runs in a browser tab, with no install and no server:
[pdo.proc.io/run](https://pdo.proc.io/run). Open or drop a `.obj` and its app
appears, running on SQLite compiled to WebAssembly and the browser's own
JavaScript engine. Nothing is uploaded.

- **One runtime, two hosts.** The browser runtime (`web/src/runtime`)
  evaluates the same `js/bootstrap.js` the native binary embeds, so
  `ctx.storage`, RPC rules and dispatch are the same code. It supplies the
  operations underneath: SQL, KV and alarms over the WebAssembly SQLite, with
  the same authorizer sandbox, one transaction and one recorded changeset per
  event.
- **Pages work as they are.** A service worker routes every request from the
  app's iframe to the object: `public/` files with the Cloudflare rules, then
  `fetch()`, and `POST /.pdo/rpc/<method>`. Links, forms, `fetch` and images
  need no changes.
- **Saving.** In Chrome and Edge a file opened with the picker or dropped on
  the page is written back in place after each change, once you allow it.
  Everywhere, Download gives you the file. A file changed in the browser opens
  in native pdo, which can undo those changes like any others.
- **Limits.** One object per tab. Alarms fire only while the tab is open. No
  editing tools or MCP yet: it runs objects, it does not build them. Object
  code has no network, and the app's pages can load only from the object
  itself, but those pages do run on the site's origin, so open files from
  people you trust. Cyclic imports are not supported there yet.

## Cloudflare

`pdo export todo.obj out/` writes the live check-in's files unchanged plus a
generated `pdo/worker.js` and `wrangler.jsonc`. The wrapper class applies the
object's migrations once per object (tracked in `_pdo_migrations`), forwards
`fetch` and `alarm` to the original class, and the entry worker gives the same
HTTP surface as `pdo run` (`POST /.pdo/rpc/<method>`). `public/` becomes
Workers Static Assets (`assets.directory`), so Cloudflare serves those files
from the edge and only unmatched requests reach the worker and the Durable
Object; a `rules` entry makes `.css`, `.md` and `.svg` text imports work as they
do locally. Moving state in or out of Cloudflare is not in v0.

## Tests

- `bun test/e2e.ts` builds the to-do example entirely through the MCP tools,
  probes the sandbox, serves it, fires the alarm, releases a bad change and
  rolls it back under a running server, checks that a rollback across a
  breaking migration is refused, serves a copy of the file, and covers static
  files (every clean-URL case, 304s, HEAD, base64 images, serving while the
  constructor throws, the export's assets config), edits, the stored-test
  release gate, data undo and redo, and the directory rules
  below (annotations, read/write separation, enforced read-only calls) (112 checks).
- `bun test/http-calls.ts <base>` runs the same 17 HTTP calls (API, RPC, alarm,
  static files, an imported template) against any host; it passes against
  `pdo run` and against the `pdo export` deploy on Cloudflare.
- `cargo test` covers the URL-to-file rules.
- `cd web && bun test/runtime.ts` runs the browser runtime under bun against
  native pdo in both directions: native builds a file, the WebAssembly runtime
  serves it (static files, fetch, RPC, alarm, the sandbox), and native opens
  what it saved, reads its KV values, undoes one of its changes and passes the
  stored tests (34 checks).
- `cd web && bun test/browser.ts` drives the real `/run` page in headless
  Chrome: the service worker, the app in its iframe, writes, download, and
  reopening from disk (23 checks). `bun test/smoke.ts <file.obj>` opens any
  object there and clicks around.

## Not yet

WebSockets, bindings, a server mode hosting a directory of objects, sync
between copies (the changesets are recorded for it), moving state to or from
Cloudflare, and a lease so only one copy is live. `pdo run` and `pdo mcp` on
the same file each hold their own isolate; in-memory fields on the class are
per process, and only `pdo run` fires alarms. `pdo` and `.obj` are working
names.

Related: celld (self-hosted Workers and Durable Objects) and Rivet Actors.
