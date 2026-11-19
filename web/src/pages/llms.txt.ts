// Generated at build time from the same facts the pages use.
import type { APIRoute } from 'astro';
import { TAGLINE, RESERVED, TOOLS, COMMANDS, RUNTIME, NOT_YET } from '../lib/facts';

export const GET: APIRoute = ({ site }) => {
  const base = (site ?? new URL('https://perch.proc.io')).origin;

  const body = `# perch (portable durable objects)

> ${TAGLINE} The \`perch\` binary (Rust, V8 via deno_core, SQLite via rusqlite)
> runs the object locally, exposes it to agents over MCP, and exports it to
> Cloudflare with the class source unchanged.

Version 0.1.0. File format_version 3. The format is still moving: perch reads only the current version. Format 2 files convert with a separate script, tools/v2-to-v3.ts.

## The file

An object file is a plain SQLite database. Tables named \`_perch_*\` are
reserved for the runtime; every other table is the object's own data, created
and changed by the object's own code through \`ctx.storage.sql\`.

${RESERVED.map((t) => `- \`${t.name}\` (${t.columns}): ${t.detail}`).join('\n')}

Schema belongs to the code, exactly as on Cloudflare: the class creates and
changes its tables in its constructor. perch has no migration system. The
usual pattern: one file per step (\`migrations/0001_name.sql\`), imported as
text, and a constructor that runs the steps a \`schema_steps\` table does not
list yet, inside \`ctx.storage.transactionSync\`. Never edit a released step;
add a new one. A constructor that throws is rolled back.

Preview: propose_change works on a sibling copy, \`<file>.preview\`.

## Writing an object

- Entry file \`src/index.ts\` exports the class named in \`_perch_meta.class\`,
  extending \`DurableObject\` from "cloudflare:workers". Constructor is
  (ctx, env); call super(ctx, env).
- Single-threaded; each event (constructor, fetch, method call, alarm) is one
  SQLite transaction.
${RUNTIME.map((r) => `- ${r.api}: ${r.note}`).join('\n')}
- Globals: Request, Response, Headers, URL, URLSearchParams, TextEncoder,
  TextDecoder, crypto.randomUUID, crypto.getRandomValues, setTimeout,
  structuredClone, atob, btoa, console.
- A SQLite authorizer refuses, from object code: any access to \`_perch_*\`
  tables (reading, writing or schema), BEGIN/COMMIT/SAVEPOINT, ATTACH, and all
  pragmas except read-only introspection (table_info, table_xinfo,
  table_list, index_list, index_info, index_xinfo, foreign_key_list).
- Keep the class Cloudflare-compatible: \`perch export\` deploys the same source.

## HTTP surface (perch run, and the perch export worker)

- GET/HEAD requests that match a file under \`public/\` are served as-is, before
  fetch() and without waking the object, with Cloudflare Static Assets'
  defaults: \`/\` is public/index.html, \`/about\` is public/about.html,
  \`/about.html\` 307s to \`/about\`, \`/docs/\` is public/docs/index.html and
  \`/docs\` 307s to it. Strong ETag (the file's SHA-256), 304 on If-None-Match,
  \`Cache-Control: public, max-age=0, must-revalidate\`. On export, public/
  becomes \`assets.directory\`.
- Every other request goes to the class's fetch() (a 404 if it has none).
- Templates import as strings: \`import page from "./page.html"\` (also .txt,
  .sql, .css, .md, .svg). Binary files go through propose_change as
  \`{ "base64": "..." }\`; 25 MiB per file.
- Many static files: \`perch import <file> <dir> --into public/img/\` (or the
  import_files tool, given a directory path) streams a directory from disk into
  public/ as one check-in on live. Tens of thousands of files are fine. Running
  the class never loads them, and listings count them instead of naming them.
  Cloudflare allows 20,000 static files per Worker version on Free and 100,000
  on Paid; export warns above either.
- Public methods are not reachable over HTTP. They are called from the shell
  (\`perch call\`), the MCP tools and stored tests. Give a page a route in
  fetch(). constructor, fetch, alarm, ctx, env and names starting with \`_\`
  are not callable.

## MCP (\`perch mcp <file>\`, stdio, JSON-RPC 2.0, one message per line)

Workflow: describe_object, read_code, propose_change (code and tests on the
preview; the constructor and the stored tests run), read_object and
call_object with target "preview" (reads and writes on the preview),
release_change (live; refused while a stored test fails). To go back to
earlier code, propose_change with from_checkin. read_object reads live;
call_object writes to it.

${TOOLS.map((t) => `- \`${t.name}\` [${t.kind}]: ${t.does}`).join('\n')}

Annotations follow Anthropic's connector directory rules: every tool has a
title and exactly one of readOnlyHint or destructiveHint. Read-only:
describe_object, read_code, query_data, read_object. Destructive (anything
that modifies data, the preview copy included): propose_change, call_object,
release_change, import_files.

Reads and writes are separate tools. read_object takes GET or HEAD (or a
public method) on live or the preview, and the runtime refuses any SQL write,
key-value write or alarm change made during it. call_object takes POST, PUT,
PATCH or DELETE, or a public method, on live or the preview; on the preview
it also takes kind alarm.

Edits: propose_change takes \`edits: [{ path, old, new, replace_all? }]\`.
\`old\` must match the file exactly and occur once. Use these after the first
version, not whole files.

Stored tests: files under \`test/\` that
\`import { test, expect } from "perch:test"\`. Each \`test(name, async (obj) => …)\`
runs on its own fresh, empty copy of the object. \`obj\` has
\`fetch(path, init)\` (an object body is a JSON POST), \`rpc(method, ...args)\`,
\`alarm()\`, \`sql(query, ...bindings)\`, \`storage\`, and
\`clock.set/advance/now\` (Date.now() follows it). \`expect\` has toBe, toEqual,
toBeTruthy, toBeFalsy, toBeNull, toBeDefined, toContain, toHaveLength,
toBeGreaterThan, toBeLessThan, toMatch and .not.

Example client config: \`claude mcp add todo -- perch mcp todo.perch\`

## CLI

${COMMANDS.map((c) => `- \`${c.usage}\`: ${c.does}`).join('\n')}

\`perch export\` writes every file byte for byte, \`perch/worker.js\` (a few
lines: it re-exports the class and routes each request to the object's
fetch()) and \`wrangler.jsonc\` with one SQLite-backed Durable Object binding. Deploy with \`bunx wrangler deploy\`.

## Out of scope in v0

${NOT_YET.map((n) => `- ${n}`).join('\n')}

## Pages

- ${base}/ : overview and quick start
- ${base}/run : open a .perch and run it in the browser (SQLite as WebAssembly, the same bootstrap as the native runtime; nothing is uploaded)
- ${base}/format : the _perch_ tables
`;

  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
