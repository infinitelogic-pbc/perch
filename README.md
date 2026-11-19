<img src="web/public/perch.svg" alt="perch" width="360">

# perch: portable durable objects

A portable durable object is one SQLite file holding both a Durable Object's
data and its code. `perch` opens the file and runs it like a Cloudflare Durable
Object, on a laptop, a server or anywhere else, and exposes an MCP wrapper so
an agent can build and change the object without a separate dev environment.

## Quick start

Build once (V8 comes prebuilt through `deno_core`):

```sh
cd perch && cargo build --release
```

Then point `bin/perch-claude` at an object file. It opens a Claude session in a
fresh, empty temp directory with only that object's MCP tools attached, and
creates the object first if the file does not exist:

```sh
bin/perch-claude ~/objects/my.perch                 # new or existing object
bin/perch-claude ~/objects/shop.perch --class Shop  # class name for a new one
bin/perch-claude my.perch -- --model sonnet "build a guestbook"   # args after -- go to claude
```

A new object is an empty class (`export class My extends DurableObject {}`)
with no tables and no data. Tell Claude what to build; it proposes code and
tests, tries them on a preview copy and releases. In a second
terminal, serve it while you work:

```sh
target/release/perch run ~/objects/my.perch              # http://127.0.0.1:8787, reloads on every release
target/release/perch describe ~/objects/my.perch         # tables, files, recent check-ins
```

The helper finds the binary at `$PERCH`, then this checkout's
`target/release/perch`, then `perch` on `PATH`, and removes the temp directory
when Claude exits. The object file stays where you put it.

## Commands

```
perch new my.perch --class Obj             # empty class, or --from <dir> with src/ (+ test/, migrations/, public/)
perch new shared.perch --like my.perch     # the same app without its data, for sharing
perch mcp my.perch                         # MCP over stdio: the agent builds it
perch run my.perch --port 8787             # serve HTTP, fire alarms
perch call my.perch <method> '[args]'      # call a public method from the shell
perch fetch my.perch /path                 # one request to fetch()
perch describe my.perch                    # tables, code, recent check-ins, next alarm
perch test my.perch                        # stored tests, each on a fresh empty copy
perch import my.perch ./photos --into public/img/   # bulk import of static files
perch export my.perch out/ && (cd out && bunx wrangler deploy)
```

`examples/todo` is a finished object to import (`perch new todo.perch --class Todo --from examples/todo`).

## The file

| Table | Holds |
| --- | --- |
| `_perch_meta` | name, class, format version (3), the live check-in |
| `_perch_blobs` | content-addressed bytes (SHA-256 → contents): every file |
| `_perch_checkins` | code history, Fossil style: id (SHA-256), parent, manifest (path → blob), message, time |
| `_perch_kv` | the key-value half of the storage API. Values are UTF-8 JSON that any runtime can read; what plain JSON cannot carry (Date, Map, Set, bytes, bigint, undefined, NaN) is tagged with `$perch` |
| `_perch_alarms` | the next scheduled alarm and its retry count |
| everything else | the object's data, created and changed by the object's own code |

That is the whole format: the code, its history, and the two pieces of state
the Durable Objects API has besides SQL.

A SQLite authorizer enforces the boundary. Object code (`ctx.storage.sql`)
owns every table that is not `_perch_`, schema included, and gets no
`BEGIN`/`SAVEPOINT`, no `ATTACH` and only introspection pragmas. `query_data`
and read calls are read-only. Only the runtime and the MCP wrapper write
reserved tables.

## Schema belongs to the code

As on Cloudflare, the class creates and changes its own tables, in its
constructor. perch has no migration system of its own. The pattern
`examples/todo` uses, and the one the agent guide teaches, keeps each step in a
file and records which have run:

```ts
import s1 from "../migrations/0001_todos.sql";
const STEPS: Record<string, string> = { "0001_todos": s1 };

export function migrate(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS schema_steps (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const done = new Set(sql.exec("SELECT name FROM schema_steps").toArray().map((r) => r.name));
    for (const [name, step] of Object.entries(STEPS)) {
      if (done.has(name)) continue;
      sql.exec(step);
      sql.exec("INSERT INTO schema_steps (name, applied_at) VALUES (?, ?)", name, Date.now());
    }
  });
}
```

The same file runs unchanged on Cloudflare. What perch adds is the place to
try a step before it touches real data:

- **The preview is a copy of the live data.** `propose_change` runs the
  constructor there, so a step that fails on real rows fails before release.
- **Stored tests start empty.** Each one builds the whole schema from nothing.
- **A constructor that throws leaves nothing behind.** Its writes are rolled
  back.
- **Release starts the new code on live.** If its constructor fails there
  (live data changed since the preview was made), the release is undone and
  live keeps the code it had.

Nothing checks that older code fits a newer schema. Rolling code back goes
through the preview like any change, and the preview is the check.

The file runs in WAL mode so `perch run` and `perch mcp` can share it, and every
commit checkpoints the WAL back into the main file, so copying the `.perch`
alone carries the object.

## The runtime

`perch run` loads the class at the live check-in into one V8 isolate and runs
events one at a time. Each event (constructor, `fetch`, a method call, `alarm`)
is one SQLite transaction. Writes made before a handler throws are kept, as
on Cloudflare; a constructor that throws is rolled back. Each call's result
reports the number of rows it wrote. When the live check-in moves (a release
from another process), the next event rebuilds the isolate and reruns the
constructor.

| Capability | API | v0 |
| --- | --- | --- |
| HTTP | `fetch(request)` | yes |
| RPC | public methods, called from the shell (`perch call`), the MCP tools and stored tests. Not reachable over HTTP: as on Cloudflare, only what `fetch()` routes is public | yes |
| SQL storage | `ctx.storage.sql.exec` (cursor: `toArray`, `one`, `raw`, `rowsRead`, `rowsWritten`), schema statements included; several statements in one call run in order | yes |
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
`_perch_blobs` with no constructor and no transaction. A class
that fails to load still serves its static files.

The rules are Cloudflare Workers Static Assets' defaults, so a page behaves
the same under `perch run` and after `perch export`:

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

### Many static files

An object can hold tens of thousands of static files. `perch import` brings a
directory in from disk:

```sh
perch import my.perch ./photos --into public/img/           # add or replace
perch import my.perch ./photos --into public/img/ --prune   # and remove what the directory lacks
```

- **Streaming.** Files go from disk into the object one at a time, so memory
  stays flat: 41,000 files import in 2 seconds, and 1 GB of 1 MB files in 6
  seconds at 18 MB of memory.
- **One check-in, straight to live.** Static files cannot change what the class
  does, so an import needs no preview. It is refused while a preview is
  unreleased, because it moves the live check-in.
- **Repeatable.** Files already present with the same contents are skipped, and
  an import that changes nothing records nothing.
- **For agents.** The `import_files` tool takes a directory path on the same
  machine, so no file passes through the conversation.
- **Cheap to carry.** Running the class never loads static files, `perch run`
  keeps an in-memory index of them (about 0.1 ms per request), and
  `describe_object` and `read_code` count them instead of listing them.
- **On Cloudflare.** Workers Static Assets allows 20,000 files per Worker
  version on the Free plan and 100,000 on Paid. `perch export` warns when
  `public/` is over either. Above 100,000, serve the files from R2.

Still to do for very large objects: a preview is a full copy of the file, and
each check-in stores the whole file list again, so code changes on a
multi-gigabyte object are slow and grow the file. The browser runtime loads
the whole file into memory.

## The MCP wrapper

`perch mcp todo.perch` serves one fixed tool set for every object, each with a
title and annotations; reads and writes are separate tools. The `initialize`
result carries a short guide to writing an object.

| Tool | Annotation | Does |
| --- | --- | --- |
| `describe_object` | readOnly | name, class, live check-in, recent code history, tables + columns + row counts, code files, a count of static files, next alarm, preview state |
| `read_code` | readOnly | files at a check-in (live, `preview`, or an id prefix); binary as `{ base64 }` by path |
| `query_data` | readOnly | read-only SQL over data tables, live or preview, 500 rows max |
| `propose_change` | destructive | whole files and `edits` (exact old/new string replacements), applied to a preview copy (`todo.perch.preview`, live data included) and built there: modules load, the constructor runs (schema steps apply), stored tests run. Proposals stack; `restart: true` starts from live; `from_checkin` starts from an earlier check-in's files, which is how code is rolled back |
| `read_object` | readOnly | a read of live or the preview: GET/HEAD to fetch() or `public/`, or a public method. Enforced by the runtime: any SQL write, KV write or alarm change is refused and the transaction is rolled back |
| `call_object` | destructive | a write call on live or the preview: POST/PUT/PATCH/DELETE to fetch(), or a public method; on the preview, also `alarm()`. Returns the result, logs and rows written |
| `release_change` | destructive | makes the preview's code live, squashed into one check-in, and starts it on the live data; refused if the preview did not build, a stored test fails, or live moved; undone if the new code does not start on live |
| `import_files` | destructive | imports a directory of static files from disk into `public/` on live, as one check-in; files stream, none pass through the agent |

## The harness is in the file

There is no separate dev environment: the artifact is the workspace, the
runtime is the sandbox, and the MCP tools are the harness. Two pieces make
that efficient for agents and safe for people who never see the code.

**Edits.** After the first version, `propose_change` takes
`edits: [{ path, old, new }]`: `old` must match the file exactly and occur once
(or set `replace_all`). A one-line fix costs one line.

**Stored tests.** Tests live in the object under `test/` and travel with it.
They run on every proposal, and `release_change` refuses while any fail; there
is no override. Each test gets its own fresh, empty copy of the object (same
code, no data; its constructor builds the tables), so results never depend on
live data, and a clock it controls:

```ts
import { test, expect } from "perch:test";

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
`toBeGreaterThan`, `toBeLessThan`, `toMatch` and `.not`. `perch test my.perch`
runs them from the shell (exit 1 on failure); `examples/todo/test` has eight.

## Claude connector directory rules

The tool set follows Anthropic's
[connector review criteria](https://claude.com/docs/connectors/building/review-criteria)
and [Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy),
checked by the end-to-end suite:

| Rule | How perch meets it |
| --- | --- |
| Every tool has a `title` and `readOnlyHint: true` or `destructiveHint: true` | All eight do, exactly one each. Four are read-only; the four that modify anything (including the preview copy) are destructive |
| No tool accepts both safe and unsafe HTTP methods | `read_object` takes only GET and HEAD; `call_object` takes only POST, PUT, PATCH and DELETE, and each refuses the other's methods with the name of the right tool |
| Read-only means read-only | `read_object` and `query_data` are enforced by the SQLite authorizer and the runtime, not by convention: writes error and nothing is saved |
| Freeform tools name their target API | `query_data` links the SQLite docs; `propose_change` links the Cloudflare Durable Objects API; the call tools name the object's own `fetch()` routes and public methods |
| Tool names are 64 characters or fewer | The longest is 15 |
| Descriptions say what the tool does, and match it | No instructions to call other software, no behavior outside the tool |
| Errors are actionable | Refusals say why and what to do instead; no bare "Bad Request" |
| Responses are sized to the task | `describe_object` lists only the ten most recent check-ins; `read_code` stubs large and binary files in the full listing and caps one file at 512 KiB; `query_data` returns at most 500 rows; tool text is compact JSON |
| No conversation data collected | perch stores only what tools are asked to store |

What a directory submission still needs, beyond the tools:

- **A remote server.** The directory accepts only remote MCP servers over
  HTTPS (Streamable HTTP), with OAuth 2.0 when sign-in is needed. `perch mcp` is
  local stdio today, so it can be listed only inside a plugin until there is a
  hosted perch (the server mode on the not-yet list, plus HTTP transport and
  OAuth).
- **Listing materials:** a public documentation URL, a privacy policy URL, a
  support contact, an icon, at least three example prompts, and a test account
  for review.

## Privacy

`perch` runs on your machine. It has no telemetry and makes no network requests
of its own. An object's code and data live in its `.perch` file and nowhere
else; object code cannot make outbound requests (`fetch` throws in v0). The
MCP server speaks only over stdio to the client that started it, and stores
only what its tools are asked to store. Data leaves the machine only when you
send it: `perch export` followed by `wrangler deploy` uploads the object's code
and static files (not its data) to your Cloudflare account, and
`perch run --host` exposes the object on the network interface you choose.

## Direction

The next layer is a framework class that lives in an object and turns it into
an app described as data, so agents configure more and code less. Its default
interface is a spreadsheet: **tables** are the typed view of the database, and
**sheets** are the UIs built on those tables. perch stays the low-level layer
underneath.

## In the browser

The same file runs in a browser tab, with no install and no server:
[perch.proc.io/run](https://perch.proc.io/run). Open or drop a `.perch` and its app
appears, running on SQLite compiled to WebAssembly and the browser's own
JavaScript engine. Nothing is uploaded.

- **One runtime, two hosts.** The browser runtime (`web/src/runtime`)
  evaluates the same `js/bootstrap.js` the native binary embeds, so
  `ctx.storage`, method-call rules and dispatch are the same code. It supplies the
  operations underneath: SQL, KV and alarms over the WebAssembly SQLite, with
  the same authorizer sandbox and one transaction per event.
- **Pages work as they are.** A service worker routes every request from the
  app's iframe to the object: `public/` files with the Cloudflare rules, then
  `fetch()`. Links, forms, `fetch` and images need no changes.
- **Saving.** In Chrome and Edge a file opened with the picker or dropped on
  the page is written back in place after each change, once you allow it.
  Everywhere, Download gives you the file. A file changed in the browser opens
  in native perch.
- **Limits.** One object per tab. Alarms fire only while the tab is open. No
  editing tools or MCP yet: it runs objects, it does not build them. Object
  code has no network, and the app's pages can load only from the object
  itself, but those pages do run on the site's origin, so open files from
  people you trust. Cyclic imports are not supported there yet.

## Cloudflare

`perch export todo.perch out/` writes the live check-in's files unchanged plus a
generated `perch/worker.js` and `wrangler.jsonc`. The Worker is a few lines: it
re-exports the class and sends every request to the one object's `fetch()`.
The class brings its own schema steps, so nothing is wrapped or translated.
`public/` becomes Workers Static Assets (`assets.directory`), so Cloudflare
serves those files from the edge and only unmatched requests reach the Worker
and the Durable Object; a `rules` entry makes `.css`, `.md` and `.svg` text
imports work as they do locally. Moving state in or out of Cloudflare is not
in v0.

## Tests

- `bun test/e2e.ts` builds the to-do example entirely through the MCP tools,
  probes the sandbox (reserved tables, transactions, ATTACH and pragmas
  refused; the object's own schema allowed), serves it, fires the alarm,
  releases a bad change and rolls it back under a running server, adds a
  schema step, checks that a step failing on live undoes the release and that
  the same step then fails on the preview, serves a copy of the file, and
  covers static files (every clean-URL case, 304s, HEAD, base64 images, serving
  while the constructor throws, the export), edits, the stored-test release
  gate, the directory rules (annotations, read/write separation, enforced
  read-only calls), bulk import of static files, and data-free copies (140
  checks).
- `bun test/http-calls.ts <base>` runs the same 16 HTTP calls (API, alarm,
  static files, an imported template) against any host; it passes against
  `perch run` and against the `perch export` project under `wrangler dev`.
- `cargo test` covers the URL-to-file rules.
- `cd web && bun test/runtime.ts` runs the browser runtime under bun against
  native perch in both directions: native builds a file, the WebAssembly runtime
  serves it (static files, fetch, method calls, alarm, the sandbox), and native
  opens what it saved, reads its KV values and passes the stored tests (39
  checks).
- `cd web && bun test/browser.ts` drives the real `/run` page in headless
  Chrome: the service worker, the app in its iframe, writes, download, and
  reopening from disk (23 checks). `bun test/smoke.ts <file.perch>` opens any
  object there and clicks around.

## Sharing an app without its data

```sh
perch new shared.perch --like my.perch
```

builds a new file with the same code, static files and stored tests, and
nothing else: no tables, no rows, no key-value entries, no alarm, no earlier
check-ins. The data is never written to the copy, so there is nothing to
recover from it; deleting rows from a duplicate of the file would leave them
in its free pages. The code builds its tables, empty, the first time it runs.

If the app needs reference data to work (a default list, settings), have the
code create it, or add it to the copy afterwards.

## Compatibility

The format is still moving. A change to it bumps `format_version`, and perch
reads only the current version: the binary carries no conversion code.

Format 2 files (schema migrations kept by perch) convert with a separate
script: `bun tools/v2-to-v3.ts old.perch new.perch`. It moves each schema
migration into the code as `migrations/<name>.sql`, generates `src/schema.ts`,
adds `migrate(ctx.storage)` to the class constructor and marks the existing
data as already migrated. Migrations that only loaded data are left out of the
code; their rows stay in the tables. The input file is not modified.

## Not yet

WebSockets, bindings, a server mode hosting a directory of objects, sync
between copies, a history of data changes with undo (an earlier version
recorded a changeset per write; it was removed as unused), a check that
older code still fits the schema, moving state to or from
Cloudflare, and a lease so only one copy is live. `perch run` and `perch mcp` on
the same file each hold their own isolate; in-memory fields on the class are
per process, and only `perch run` fires alarms. `perch` and `.perch` are working
names.

Related: celld (self-hosted Workers and Durable Objects) and Rivet Actors.
