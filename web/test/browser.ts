// Real-browser check of the /run page, in headless Chrome:
// service-worker routing, the app in its iframe, writes, download, and
// opening a file from disk. The downloaded file goes back to native perch.
//
//   bunx wrangler dev --port 8799     (in another terminal, after bun run build)
//   bun test/browser.ts [base-url]

import puppeteer from "puppeteer-core";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:8799";
const ROOT = join(import.meta.dir, "../..");
const PERCH = process.env.PERCH ?? join(ROOT, "target/release/perch");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const dir = mkdtempSync(join(tmpdir(), "perch-browser-"));

let n = 0;
function ok(cond: unknown, what: string) {
  if (!cond) {
    console.error(`FAIL ${what}`);
    process.exit(1);
  }
  n++;
  console.log(`ok   ${what}`);
}
function sh(args: string[]): any {
  const r = Bun.spawnSync([PERCH, ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`perch ${args.join(" ")}: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString());
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(",") : [])] });
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(`${m.text()} @${m.location()?.url ?? ""}`); });
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });

await page.goto(`${BASE}/run`, { waitUntil: "networkidle0" });
ok((await page.title()).includes("Run an object"), "the run page loads");

async function appFrame() {
  for (let i = 0; i < 100; i++) {
    const f = page.frames().find((fr) => fr !== page.mainFrame() && fr.url().startsWith(BASE) && !fr.url().includes("about:blank"));
    if (f) return f;
    await sleep(100);
  }
  throw new Error(`the app frame never loaded (status: ${await page.$eval("#start-status", (e) => e.textContent)}; errors: ${errors.join(" | ")})`);
}

// ------------------------------------------------------------------ the example object
await page.click("#example");
let frame = await appFrame();
await frame.waitForSelector("#list li", { timeout: 15000 });
ok((await frame.title()) === "To-do", "the object's page is served to the iframe by the service worker");
ok((await frame.$$eval("#list li", (els) => els.length)) === 2, "the page's own fetch() to /todos reaches the object (2 items)");
const css = await frame.evaluate(() => getComputedStyle(document.querySelector("button")!).backgroundColor);
ok(css !== "rgba(0, 0, 0, 0)" && css !== "rgb(239, 239, 239)", "the object's stylesheet is applied");
ok(await frame.evaluate(() => (document.querySelector("img") as HTMLImageElement).naturalWidth === 16), "a binary static file (PNG) renders");

await frame.type("input[name=title]", "typed in headless Chrome");
await frame.click("button");
await frame.waitForFunction(() => document.querySelectorAll("#list li").length === 3, { timeout: 10000 });
ok(true, "a POST from the page writes a row and the list updates");
await frame.click("#list li:last-child input[type=checkbox]");
await frame.waitForFunction(() => document.querySelector("#list li:last-child span")?.className === "done", { timeout: 10000 });
ok(true, "a PATCH from the page marks it done");

const status = await page.$eval("#save-status", (e) => e.textContent);
ok(/Unsaved changes/.test(status ?? ""), "the runner shows there are unsaved changes");

// A link click inside the app: a navigation, routed to fetch() and a template.
await frame.click('a[href="/stats"]');
await page.waitForFunction(() => (document.getElementById("path") as HTMLInputElement).value === "/stats", { timeout: 10000 });
frame = await appFrame();
ok((await frame.content()).includes("<td>Total</td><td>3</td>"), "following a link renders a dynamic page from the object");
ok((await page.$eval("#path", (e) => (e as HTMLInputElement).value)) === "/stats", "the address bar follows the app");

// Clean URLs and the cage.
const probe = await frame.evaluate(async () => {
  const r = await fetch("/index.html", { redirect: "manual" });
  const api = await (await fetch("/api/stats")).json();
  const css = await fetch("/app.css");
  let outside = "allowed";
  try { await fetch("https://example.com/"); } catch { outside = "blocked"; }
  return { redirect: r.type === "opaqueredirect" || r.status === 307, api: api.total, csp: css.headers.get("content-security-policy"), etag: css.headers.get("etag"), outside };
});
ok(probe.redirect, "/index.html redirects, as on Cloudflare");
ok(probe.api === 3, "the page reaches the object through a route its class defines");
ok(probe.etag && probe.csp?.includes("default-src 'self'"), "responses carry the ETag and the content security policy");
ok(probe.outside === "blocked", "the object's page cannot fetch another site");

// The top-level site is untouched by the service worker.
const top = await page.evaluate(async () => (await fetch("/llms.txt")).ok && (await (await fetch("/todos")).status));
ok(top === 404, "requests from the site's own page still go to the network (/todos is a 404 there)");

// ------------------------------------------------------------------ download, and back to native perch
await page.click("details.panel summary");
const facts = await page.$eval("#facts", (e) => e.textContent ?? "");
ok(facts.includes("Todo") && /Check-ins\d+/.test(facts), "the panel shows what is inside the file");
await page.click("#download");
let saved = "";
for (let i = 0; i < 50 && !saved; i++) {
  await sleep(200);
  saved = readdirSync(dir).find((f) => f.endsWith(".perch")) ?? "";
}
ok(saved === "todo.perch", "Download saves the object as a file");
const out = join(dir, saved);
const d = sh(["describe", out]);
ok(d.tables.find((t: any) => t.name === "todos").rows === 3, "native perch opens the downloaded file and sees the row typed in the browser");
const rows = sh(["call", out, "stats"]).result;
ok(rows.total === 3 && rows.done === 1, "native perch agrees with the browser about the data");
ok(sh(["test", out]).passed === 8, "the downloaded file passes its stored tests under native perch");

// ------------------------------------------------------------------ open a file from disk
await page.click("#close");
sh(["call", out, "add", '["added by native perch after the download"]']);
const input = await page.$("#file");
await (input as any).uploadFile(out);
frame = await appFrame();
await frame.waitForFunction(() => document.querySelectorAll("#list li").length === 4, { timeout: 15000 });
ok(true, "the file opens again from disk, with the row native perch added in between");
ok((await page.$eval("#obj-name", (e) => e.textContent)) === "todo.perch", "the runner shows the file's name");

// Two errors are expected: this test asks for an outside site (blocked) and for /todos from the top page (404).
const real = errors.filter((e) => !e.includes("example.com") && !e.includes("Content Security Policy") && !e.endsWith("/todos"));
ok(real.length === 0, `no page errors${real.length ? ": " + real.join(" | ") : ""}`);
await browser.close();
console.log(`\n${n} checks passed in headless Chrome against ${BASE}`);
process.exit(0);
