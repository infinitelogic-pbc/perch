#!/usr/bin/env bun
// The binary is the one source for what the tools and commands are. This asks
// it (the MCP `initialize` guide, `tools/list`, `--help`) and writes the answer
// where the docs read it:
//
//   web/src/lib/generated.json   the site pages and /llms.txt
//   README.md                    the tables between the <!-- generated --> marks
//
//   bun tools/gen-facts.ts           regenerate
//   bun tools/gen-facts.ts --check   exit 1 if either file is out of date

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const WEB = join(import.meta.dir, "..");
const ROOT = join(WEB, "..");
const PERCH = process.env.PERCH ?? join(ROOT, "target/release/perch");
const check = process.argv.includes("--check");

const run = (args: string[]) => {
  const r = spawnSync(PERCH, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`perch ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

// ---- commands, from --help
const help = run(["--help"]);
const names = help
  .split("Commands:\n")[1]
  .split("\n\n")[0]
  .split("\n")
  .map((l) => l.trim().split(/\s+/)[0])
  .filter((n) => n && n !== "help");
const commands = names.map((name) => {
  const h = run([name, "--help"]);
  const usage = h.match(/^Usage: (.*)$/m)![1].replace(" [OPTIONS]", "");
  const options = [...h.matchAll(/^\s+(?:-\w, )?(--[a-z-]+(?: <[A-Z_]+>)?)/gm)].map((m) => m[1]).filter((o) => o !== "--help");
  return { name, usage: [usage, ...options.map((o) => `[${o}]`)].join(" "), about: h.split("\n")[0].trim() };
});

// ---- the guide and the tools, from the MCP server itself
const dir = mkdtempSync(join(tmpdir(), "perch-facts-"));
run(["new", join(dir, "x.perch")]);
const mcp = spawn(PERCH, ["mcp", join(dir, "x.perch")], { stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map<number, (v: any) => void>();
createInterface({ input: mcp.stdout! }).on("line", (l) => {
  const m = JSON.parse(l);
  waiting.get(m.id)?.(m);
});
let id = 1;
const rpc = (method: string, params: unknown = {}) =>
  new Promise<any>((res) => {
    waiting.set(id, res);
    mcp.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) + "\n");
  });
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gen-facts", version: "0" } });
const list = await rpc("tools/list");
mcp.kill();
rmSync(dir, { recursive: true, force: true });

const tools = list.result.tools.map((t: any) => ({
  name: t.name,
  title: t.title,
  kind: t.annotations.readOnlyHint ? "read" : "destructive",
  description: t.description,
}));
const generated = JSON.stringify({ guide: init.result.instructions, tools, commands }, null, 2) + "\n";

// ---- README tables
const cell = (s: string) => s.replace(/\|/g, "\\|");
const blocks: Record<string, string> = {
  tools: ["| Tool | Annotation | Does |", "| --- | --- | --- |", ...tools.map((t: any) => `| \`${t.name}\` | ${t.kind === "read" ? "readOnly" : "destructive"} | ${cell(t.description)} |`)].join("\n"),
  commands: ["```sh", ...commands.map((c) => `# ${c.about}\n${c.usage}`), "```"].join("\n"),
};
const readmePath = join(ROOT, "README.md");
let readme = readFileSync(readmePath, "utf8");
for (const [key, text] of Object.entries(blocks)) {
  const re = new RegExp(`(<!-- generated:${key} -->\\n)[\\s\\S]*?(<!-- /generated:${key} -->)`);
  if (!re.test(readme)) throw new Error(`README.md has no <!-- generated:${key} --> block`);
  readme = readme.replace(re, (_, a, b) => a + text + "\n" + b);
}

const jsonPath = join(WEB, "src/lib/generated.json");
const stale = [
  [jsonPath, generated],
  [readmePath, readme],
].filter(([p, want]) => {
  let have = "";
  try { have = readFileSync(p, "utf8"); } catch {}
  return have !== want;
});
if (check) {
  if (stale.length) {
    console.error(`out of date: ${stale.map(([p]) => p).join(", ")}\nrun: bun tools/gen-facts.ts`);
    process.exit(1);
  }
  console.log("docs match the binary");
} else {
  for (const [p, want] of stale) writeFileSync(p, want);
  console.log(stale.length ? `wrote ${stale.map(([p]) => p).join(", ")}` : "already up to date");
}
process.exit(0);
