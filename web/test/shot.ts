// Screenshot a page or a local SVG in headless Chrome, light and dark.
//   bun test/shot.ts <url-or-file> <out.png> [width] [height] [dark]

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";

const [target, out, w = "1280", h = "800", scheme = "light"] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(",") : [],
});
const page = await browser.newPage();
await page.setViewport({ width: Number(w), height: Number(h), deviceScaleFactor: 2 });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
if (/^https?:/.test(target)) {
  await page.goto(target, { waitUntil: "networkidle0" });
} else {
  const bg = scheme === "dark" ? "#141517" : "#f3efe4";
  await page.setContent(`<body style="margin:0;background:${bg};display:grid;place-items:center;height:100vh"><div style="width:80%">${readFileSync(target, "utf8")}</div></body>`, { waitUntil: "networkidle0" });
}
await page.screenshot({ path: out });
await browser.close();
process.exit(0);
