// Generated at build time from the same facts the pages use.
import type { APIRoute } from 'astro';
import { TAGLINE, RESERVED, TOOLS, COMMANDS, GUIDE, NOT_YET } from '../lib/facts';

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

## The agent guide

This is what \`perch mcp\` gives an agent when it connects, word for word.

${GUIDE}

## HTTP surface (perch run, and the perch export worker)

- GET/HEAD requests that match a file under \`public/\` are served as-is, before
  fetch() and without waking the object, with Cloudflare Static Assets'
  defaults: \`/\` is public/index.html, \`/about\` is public/about.html,
  \`/about.html\` 307s to \`/about\`, \`/docs/\` is public/docs/index.html and
  \`/docs\` 307s to it. Strong ETag (the file's SHA-256), 304 on If-None-Match,
  \`Cache-Control: public, max-age=0, must-revalidate\`. On export, public/
  becomes \`assets.directory\`.
- Every other request goes to the class's fetch() (a 404 if it has none).
  Public methods are not reachable over HTTP.
- Many static files: \`perch import <file> <dir> --into public/img/\` (or the
  import_files tool, given a directory path) streams a directory from disk into
  public/ as one check-in on live. Running the class never loads them.
  Cloudflare allows 20,000 static files per Worker version on Free and 100,000
  on Paid; export warns above either.

## MCP tools (\`perch mcp <file>\`, stdio, JSON-RPC 2.0, one message per line)

Every tool has a title and exactly one of readOnlyHint or destructiveHint.

${TOOLS.map((t) => `- \`${t.name}\` [${t.kind}]: ${t.does}`).join('\n')}

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
