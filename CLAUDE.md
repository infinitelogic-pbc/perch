# Working on perch

perch is portable durable objects: one SQLite file (`.perch`) holding a
Cloudflare-style Durable Object's code and data, a Rust runtime that runs it,
an MCP wrapper so agents can build it, a browser runtime, and an export to
Cloudflare. README.md is the user-facing description; this file is what to
know before changing things.

## Principles

- **Barebones and Cloudflare-like.** When a perch-only mechanism duplicates
  something Cloudflare leaves to the object's code, remove it. Schema is the
  class's own job (it creates and changes its tables in its constructor);
  only what `fetch()` routes is reachable over HTTP.
- **No compatibility code in the binary.** The format is still moving. A
  format change bumps `format_version` in `src/store.rs`, the binary reads
  only the current version, and a conversion, when one is wanted, is a
  separate script under `tools/` (see `tools/v2-to-v3.ts`).
- **The binary is the source for the docs.** After changing a tool, a command
  or the agent guide (`GUIDE` in `src/mcp.rs`), run `bun run facts` in `web/`.
  It rewrites `web/src/lib/generated.json` and the README blocks between the
  `<!-- generated:... -->` marks; `bun tools/gen-facts.ts --check` fails when
  they are stale.

## Layout

- `src/store.rs`: the file format, the SQLite authorizer (privileged,
  sandbox, read-only), blobs, check-ins, `clone_to` (the preview copy).
- `src/engine.rs`: V8 through deno_core, module loading, the storage ops.
- `src/host.rs`: one object, one event per transaction, alarms, static files.
- `src/tools.rs`: the MCP tools' logic (propose, release, calls, import).
- `src/mcp.rs`: MCP over stdio, tool schemas, the agent guide.
- `js/bootstrap.js`: Workers globals and `ctx.storage`, shared with the
  browser runtime, which evaluates the same file.
- `web/`: the site (Astro, assets-only Worker) and the browser runtime
  (`web/src/runtime`, SQLite as WebAssembly).
- `examples/todo`: the reference object, including the schema-step pattern.

## Things that are easy to get wrong

- **Two runtimes.** The authorizer rules and the static-file rules exist in
  Rust (`src/store.rs`, `src/assets.rs`) and in TypeScript
  (`web/src/runtime/objrun.ts`, `assets.ts`). Change both.
- **Isolate drop order.** `Tools` holds a live and a preview object, each its
  own V8 isolate on one thread. They are dropped together, newest first
  (`drop_hosts`); dropping an older isolate while a newer one lives is a fatal
  V8 HandleScope error.
- **The preview is rebuilt from live on every proposal.** Only the pending
  change's files carry over. Validate a proposal fully before replacing the
  old preview.
- **A constructor that throws is rolled back; other handlers keep the writes
  made before a throw**, as on Cloudflare.
- **Moving the checkout** leaves a stale path in the v8 crate's build output:
  `cargo clean --release -p v8` and rebuild.

## Checks

```sh
cargo build --release && cargo test --release
PERCH=$PWD/target/release/perch bun test/e2e.ts      # native, through the MCP tools
cd web && bun test/runtime.ts                        # browser runtime against native
cd web && bun tools/gen-facts.ts --check             # docs match the binary
cd web && bun run check && bun run build
cd web && bunx wrangler dev --port 8799 & bun test/browser.ts   # headless Chrome
```

`test/http-calls.ts <base>` runs the same HTTP calls against `perch run` and
against a `perch export` project under `wrangler dev`.

## Site

`cd web && bun run deploy` builds and deploys perch.proc.io. The domain is
`PERCH_SITE` in `web/astro.config.mjs` and the route in `web/wrangler.jsonc`.

## License

AGPL-3.0-only, copyright Infinite Logic PBC. New source files need no header;
LICENSE at the root covers the repository.
