// Dollhouse smoke test: load a project (or the demo house), open /dollhouse, screenshot each floor and control.
// Usage: node scripts/e2e-dollhouse.mjs [baseUrl] [outDir]
//   PROJECT=path/to/export.json   load a project export instead of the demo house
//   WALLART=path/to/wallart.json  wall art saved by an earlier e2e-flythrough WALLS=1 run
//   DEPTH=path/to/depth.json      depth maps to put into the project (the dollhouse doesn't use them; kept for parity)
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
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
const landscape = !!process.env.LANDSCAPE;
const ctx = await browser.newContext({
  viewport: landscape ? { width: 844, height: 390 } : { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
  if (process.env.VERBOSE) console.log(`[${m.type()}] ${m.text()}`);
});

await page.goto(base);
await page.evaluate((pw) => pw && localStorage.setItem("house-viewer:access", JSON.stringify({ password: pw })), process.env.ACCESS_PASSWORD ?? "");
if (process.env.PROJECT) {
  await page.reload();
  await page.locator('input[type="file"][accept*="json"]').setInputFiles(process.env.PROJECT);
  await page.waitForTimeout(3000);
  if (process.env.DEPTH || process.env.WALLART) {
    const depth = process.env.DEPTH ? JSON.parse(readFileSync(process.env.DEPTH, "utf8")) : {};
    const wallArt = process.env.WALLART ? JSON.parse(readFileSync(process.env.WALLART, "utf8")) : {};
    const n = await page.evaluate(async ({ depth, wallArt }) => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open("house-viewer", 1);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const store = () => db.transaction("kv", "readwrite").objectStore("kv");
      const project = await new Promise((res) => (store().get("project:current").onsuccess = (e) => res(e.target.result)));
      for (const [id, d] of Object.entries(depth)) project.depth[id] = { photoId: id, ...d };
      project.wallArt = { ...(project.wallArt ?? {}), ...wallArt };
      await new Promise((res) => (store().put(project, "project:current").onsuccess = res));
      return `${Object.keys(project.depth).length} depth maps, ${Object.keys(project.wallArt).length} rooms of wall art`;
    }, { depth, wallArt });
    console.log(`injected ${n}`);
  }
} else {
  await page.getByRole("button", { name: "Try the demo house" }).first().click();
  await page.waitForURL("**/analyze", { timeout: 120_000 });
  await page.waitForSelector("text=6 rooms");
  await page.waitForTimeout(1000); // project save is debounced
}

await page.goto(`${base}/dollhouse`);
await page.waitForSelector("canvas", { timeout: 60_000 }).catch(async (e) => {
  await page.screenshot({ path: `${out}/no-canvas.png`, fullPage: true });
  throw e;
});
await page.waitForTimeout(3000);
const stage = page.locator(".stage");
const shot = async (name) => {
  await page.waitForTimeout(1200); // camera moves ease in over 0.7 s
  await stage.screenshot({ path: `${out}/${name}.png` });
  console.log(`shot ${name} ${(await page.locator(".stage-title").innerText()).trim()}`);
};
await shot("00-home");

const floors = await page.locator(".doll-floors button").allInnerTexts();
console.log(`floors (top first): ${floors.join(", ") || "(one)"}`);
for (const [i, name] of floors.entries()) {
  await page.locator(".doll-floors button").nth(i).click();
  await shot(`01-floor-${i}-${name.toLowerCase().replace(/\W+/g, "-")}`);
}

const box = await page.locator(".stage canvas").boundingBox();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.4, { steps: 10 });
await page.mouse.up();
await shot("02-spun");

await page.getByRole("button", { name: "Zoom in" }).click();
await page.getByRole("button", { name: "Zoom in" }).click();
await shot("03-zoomed");

await page.getByRole("button", { name: "Top" }).click();
await shot("04-top");

await page.getByLabel("Wall height").fill("0.4");
await page.getByRole("button", { name: "⟲" }).click();
await shot("05-low-walls");

await page.getByLabel("Wall height").fill("1");
await page.getByLabel("outside walls").check();
await shot("06-siding");
await page.getByLabel("outside walls").uncheck();

const chips = page.locator('.chips[aria-label="Rooms"] .chip');
const n = await chips.count();
for (const i of [0, Math.floor(n / 2), n - 1].filter((v, k, a) => a.indexOf(v) === k)) {
  await chips.nth(i).click();
  await shot(`07-room-${i}`);
}

// A room label on the view flies to that room too.
await page.getByRole("button", { name: "⟲" }).click();
await page.waitForTimeout(1200);
const label = page.locator(".doll-label").filter({ visible: true }).first();
if (await label.count()) {
  const name = await label.innerText();
  await label.click();
  await shot("08-label-click");
  console.log(`label click → ${name}`);
}

await page.screenshot({ path: `${out}/page.png`, fullPage: true });
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no page errors");
await browser.close();
