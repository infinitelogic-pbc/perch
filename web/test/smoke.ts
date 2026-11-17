// Open any .perch in the /run page in headless Chrome and click around.
// The file is uploaded to the page, never written.
//   bun test/smoke.ts <file.perch> [base-url]

import puppeteer from "puppeteer-core";

const [file, BASE = "http://127.0.0.1:8799"] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`${BASE}/run`, { waitUntil: "networkidle0" });
const t0 = Date.now();
await ((await page.$("#file")) as any).uploadFile(file);

async function appFrame() {
  for (let i = 0; i < 150; i++) {
    const f = page.frames().find((fr) => fr !== page.mainFrame() && fr.url().startsWith(BASE));
    if (f) return f;
    await sleep(100);
  }
  throw new Error(`no app frame: ${await page.$eval("#start-status", (e) => e.textContent)} ${errors.join(" | ")}`);
}
let frame = await appFrame();
await frame.waitForSelector("body *", { timeout: 20000 });
await sleep(500);
const first = { title: await frame.title(), openMs: Date.now() - t0, links: await frame.$$eval("a[href^='/']", (a) => a.map((x) => x.getAttribute("href"))), summary: await page.$eval("#summary", (e) => e.textContent) };
console.log(JSON.stringify({ ...first, links: [...new Set(first.links)].slice(0, 12) }));

// Visit a few of the app's own links.
for (const href of [...new Set(first.links)].filter((h) => h && h !== "/").slice(0, 4)) {
  await page.$eval("#path", (el, v) => { (el as HTMLInputElement).value = v as string; }, href);
  await page.$eval("#go", (f) => (f as HTMLFormElement).requestSubmit());
  await sleep(700);
  frame = await appFrame();
  const text = await frame.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 110));
  console.log(JSON.stringify({ href, title: await frame.title(), text }));
}
await page.screenshot({ path: process.env.SHOT ?? "/dev/null" }).catch(() => {});
console.log(JSON.stringify({ errors: errors.slice(0, 5), saveStatus: await page.$eval("#save-status", (e) => e.textContent) }));
await browser.close();
process.exit(0);
