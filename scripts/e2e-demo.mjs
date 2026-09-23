// End-to-end smoke test: demo house → in-browser depth → tour, with screenshots.
// Usage: node scripts/e2e-demo.mjs [baseUrl] [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${process.execPath.replace(/bin\/node$/, "")}lib/node_modules/playwright`);
}

const base = process.argv[2] ?? "http://localhost:3000";
const out = process.argv[3] ?? "e2e-shots";
mkdirSync(out, { recursive: true });

const browser = await playwright.chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--ignore-certificate-errors"],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
  if (process.env.VERBOSE) console.log(`[${m.type()}] ${m.text()}`);
});
const shot = async (name) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`shot ${name}`);
};

await page.goto(base);
await shot("01-intake");
await page.getByRole("button", { name: "Try the demo house" }).first().click();
await page.waitForURL("**/analyze", { timeout: 120_000 });
await page.waitForSelector("text=6 rooms");
await shot("02-analyze");

const engine = process.env.DEPTH_ENGINE ?? "browser";
await page.locator("select.input").selectOption(engine);
await page.getByRole("button", { name: "Estimate depth" }).scrollIntoViewIfNeeded();
await shot("02b-depth-card");
const t0 = Date.now();
await page.getByRole("button", { name: "Estimate depth" }).click();
await page.waitForFunction(() => /9\/9 photos/.test(document.body.innerText), null, { timeout: 600_000 });
console.log(`depth (${engine}) for 9 photos took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await page.locator(".match-room").first().scrollIntoViewIfNeeded();
await shot("03-depth");

await page.getByRole("button", { name: "View in 3D" }).first().click();
await page.waitForTimeout(2500);
await shot("04-stereo-test");
await page.getByRole("button", { name: "Close" }).click();

await page.getByRole("link", { name: "Start tour →" }).click();
await page.waitForURL("**/tour");
await page.waitForTimeout(4000);
await shot("05-tour-living");
console.log("status:", await page.locator(".controls .row.small").innerText().catch(() => "?"));

await page.getByRole("button", { name: "Kitchen →" }).click();
await page.waitForTimeout(300);
await shot("06-transition");
await page.waitForTimeout(2500);
await shot("07-tour-kitchen");
console.log("status:", await page.locator(".controls .row.small").innerText().catch(() => "?"));

await page.getByRole("button", { name: "Wiggle" }).click();
await page.getByRole("button", { name: "Hall", exact: false }).first().click().catch(() => {});
await page.waitForTimeout(2500);
await shot("08-plan-tap");

await ctx.close();
await browser.close();
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no page errors");
