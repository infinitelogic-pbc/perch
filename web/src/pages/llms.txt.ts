// Generated at build time from the same facts the pages use.
import type { APIRoute } from 'astro';
import { TAGLINE, RESERVED, TOOLS, COMMANDS, RUNTIME, NOT_YET } from '../lib/facts';

export const GET: APIRoute = ({ site }) => {
  const base = (site ?? new URL('https://pdo.proc.io')).origin;

  const body = `# pdo (portable durable objects)

> ${TAGLINE} The \`pdo\` binary (Rust, V8 via deno_core, SQLite via rusqlite)
> runs the object locally, exposes it to agents over MCP, and exports it to
> Cloudflare with the class source unchanged.

Version 0.1.0. File format_version 1, api_version pdo-v0.

## The file

An object file is a plain SQLite database. Tables named \`_obj_*\` are
reserved for the runtime; every other table is the object's own data, created
only by migrations and reached by object code through \`ctx.storage.sql\`.

${RESERVED.map((t) => `- \`${t.name}\` (${t.columns}): ${t.detail}`).join('\n')}

Data table rules: every table needs a declared PRIMARY KEY; AUTOINCREMENT is
refused; use UUIDv7 TEXT keys (build v7 from Date.now() plus
crypto.getRandomValues; crypto.randomUUID() is v4). Migrations are ordered,
named, forward-only SQL.

Preview: propose_change works on a sibling copy, \`<file>.preview\`.

## Writing an object

- Entry file \`src/index.ts\` exports the class named in \`_obj_meta.class\`,
  extending \`DurableObject\` from "cloudflare:workers". Constructor is
  (ctx, env); call super(ctx, env).
- Single-threaded; each event (fetch, RPC, alarm) is one SQLite transaction.
${RUNTIME.map((r) => `- ${r.api}: ${r.note}`).join('\n')}
- Globals: Request, Response, Headers, URL, URLSearchParams, TextEncoder,
  TextDecoder, crypto.randomUUID, crypto.getRandomValues, setTimeout,
  structuredClone, atob, btoa, console.
- A SQLite authorizer refuses, from object code: any access to \`_obj_*\`
  tables, DDL (CREATE/ALTER/DROP), BEGIN/COMMIT/SAVEPOINT, ATTACH, and all
  pragmas except read-only introspection (table_info, table_xinfo,
  table_list, index_list, index_info, index_xinfo, foreign_key_list).
- Keep the class Cloudflare-compatible: \`pdo export\` deploys the same source.

## HTTP surface (pdo run, and the pdo export worker)

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
- \`POST /.pdo/rpc/<method>\` with a JSON array body calls a public method and
  returns \`{"result": ...}\`. constructor, fetch, alarm, ctx, env and
  names starting with \`_\` are not RPC.

## MCP (\`pdo mcp <file>\`, stdio, JSON-RPC 2.0, one message per line)

Workflow: describe_object, read_code, propose_change (code + tests +
migrations on the preview; stored tests run), test_call (on the preview),
release_change (live; refused while a stored test fails). rollback_code moves
code back if it still fits the schema. undo_changes reverses recent data
changes. call_object hits live.

${TOOLS.map((t) => `- \`${t.name}\` [${t.kind}]: ${t.does}`).join('\n')}

Annotations: describe_object, read_code, list_checkins, query_data, run_tests
and list_changes are readOnlyHint; release_change, rollback_code,
undo_changes and call_object are destructiveHint. call_object takes kind
fetch or rpc; test_call also takes kind alarm.

Edits: propose_change takes \`edits: [{ path, old, new, replace_all? }]\`.
\`old\` must match the file exactly and occur once. Use these after the first
version, not whole files.

Stored tests: files under \`test/\` that
\`import { test, expect } from "pdo:test"\`. Each \`test(name, async (obj) => …)\`
runs on its own fresh, empty copy of the object. \`obj\` has
\`fetch(path, init)\` (an object body is a JSON POST), \`rpc(method, ...args)\`,
\`alarm()\`, \`sql(query, ...bindings)\`, \`storage\`, and
\`clock.set/advance/now\` (Date.now() follows it). \`expect\` has toBe, toEqual,
toBeTruthy, toBeFalsy, toBeNull, toBeDefined, toContain, toHaveLength,
toBeGreaterThan, toBeLessThan, toMatch and .not.

Checkout: \`pdo checkout <file> <dir>\` writes plain files; \`pdo commit <dir>
-m MSG\` brings them back through the same build-and-test gate.

Example client config: \`claude mcp add todo -- pdo mcp todo.obj\`

## CLI

${COMMANDS.map((c) => `- \`${c.usage}\`: ${c.does}`).join('\n')}

\`pdo export\` writes \`src/**\` byte for byte, \`pdo/worker.js\` (a wrapper
that applies migrations once per object, tracked in \`_pdo_migrations\`, and
serves the RPC route), \`pdo/migrations.js\` and \`wrangler.jsonc\` with one
SQLite-backed Durable Object binding. Deploy with \`bunx wrangler deploy\`.

## Out of scope in v0

${NOT_YET.map((n) => `- ${n}`).join('\n')}

## Pages

- ${base}/ : overview and quick start
- ${base}/format : the _obj_ tables
`;

  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
