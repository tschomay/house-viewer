import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const playwright = require(`${process.execPath.replace(/bin\/node$/, "")}lib/node_modules/playwright`);
// Real-listing tour check: import a project export, add depth (saved maps, or run the on-device model),
// then visit the multi-photo rooms, screenshotting each (at rest and turned) and logging the
// [room-model] alignment lines to <outDir>/real-room-models.txt.
// Usage: ACCESS_PASSWORD=... node scripts/e2e-real-tour.mjs <outDir> <project.json> [depth.json]
// The Avon house project and its depth maps live in the private repo tschomay/house-viewer-fixtures.
const [out, file, depthFile] = process.argv.slice(2);
const base = process.env.BASE_URL ?? "http://localhost:3100";
const browser = await playwright.chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--ignore-certificate-errors"] });
const ctx = await browser.newContext({ viewport: { width: 800, height: 700 }, deviceScaleFactor: 1 });
await ctx.addInitScript((pw) => localStorage.setItem("house-viewer:access", JSON.stringify({ password: pw })), process.env.ACCESS_PASSWORD ?? "");
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => { if (m.text().startsWith("[room-model]")) logs.push(m.text()); });
page.on("pageerror", (e) => console.log("pageerror", e.message));
page.on("dialog", (d) => d.accept());
await page.goto(base);
await page.locator('input[type="file"][accept*="json"]').setInputFiles(file);
await page.waitForTimeout(1500);
await page.goto(`${base}/analyze`);
await page.waitForTimeout(2000);
const { existsSync, readFileSync } = await import("node:fs");
const reuse = !!depthFile && existsSync(depthFile);
await page.locator("select.input").selectOption("browser");
const t0 = Date.now();
if (reuse) {
  // Put saved depth maps straight into the project and reload: skips ~10 min of model inference.
  const depthJson = readFileSync(depthFile, "utf8");
  await page.evaluate(async (dj) => {
    const db = await new Promise((res) => { const r = indexedDB.open("house-viewer", 1); r.onsuccess = () => res(r.result); });
    const st = () => db.transaction("kv", "readwrite").objectStore("kv");
    const p = await new Promise((res) => (st().get("project:current").onsuccess = (e) => res(e.target.result)));
    p.depth = JSON.parse(dj);
    await new Promise((res) => (st().put(p, "project:current").onsuccess = res));
  }, depthJson);
  await page.reload();
  await page.waitForTimeout(2000);
} else {
await page.getByRole("button", { name: "Estimate depth" }).click();
// Exterior photos are skipped, so wait for the run to finish rather than for N/N.
await page.waitForSelector(".card .spinner", { timeout: 30_000 });
await page.waitForFunction(() => !document.querySelector(".card .spinner"), null, { timeout: 1_800_000 });
console.log("depth done");
}
console.log(`depth took ${((Date.now() - t0) / 1000).toFixed(0)}s`);
// Keep depth maps so later runs can skip this step.
const depth = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("house-viewer", 1);
  r.onsuccess = () => (r.result.transaction("kv").objectStore("kv").get("project:current").onsuccess = (e) => res(e.target.result.depth));
}));
if (!reuse) writeFileSync(`${out}/real-depth.json`, JSON.stringify(depth));
console.log("depth maps:", Object.keys(depth).length);
await page.getByRole("link", { name: "Start tour →" }).click();
await page.waitForURL("**/tour");
await page.waitForTimeout(4000);
await page.getByRole("button", { name: "Flat" }).click();
for (const room of ["Family", "Kitchen", "Living", "Library", "Foyer", "MBATH", "Nook", "Dining"]) {
  const chip = page.locator(".plan-label", { hasText: new RegExp(`^${room}`, "i") }).first();
  if (!(await chip.count())) { console.log("no label", room); continue; }
  await chip.evaluate((el) => el.click());
  await page.waitForTimeout(4000);
  await page.locator(".stage").screenshot({ path: `${out}/real-${room}-0.png` });
  const status = await page.locator(".controls .row.small.muted").first().innerText().catch(() => "?");
  console.log(room, "|", status.replace(/\n/g, " "));
  const c = await page.locator(".stage canvas").first().boundingBox();
  if (c) {
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width / 2 - 200, c.y + c.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    await page.locator(".stage").screenshot({ path: `${out}/real-${room}-1.png` });
  }
}
writeFileSync(`${out}/real-room-models.txt`, logs.join("\n"));
await browser.close();
