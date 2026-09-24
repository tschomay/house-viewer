// 3D fly-through smoke test: load a project (or the demo house), open /flythrough, screenshot along the route.
// Usage: node scripts/e2e-flythrough.mjs [baseUrl] [outDir]
//   PROJECT=path/to/export.json   load a project export instead of the demo house
//   WALLS=1                       also run the AI wall fill (costs ≈$0.07 a room) and re-shoot
//   ACCESS_PASSWORD=...           needed for WALLS=1 when the server has a password
//   DEPTH=path/to/depth.json      depth maps to put into the project ({ photoId: DepthMap }), skipping on-device inference
//   WALLART=path/to/wallart.json  reuse wall art saved by an earlier WALLS=1 run (it writes <outDir>/wallart.json)
//   LAYOUT=mono|cross|parallel    stereo layout (default mono)
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const landscape = process.env.LAYOUT === "cross" || process.env.LAYOUT === "parallel";
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
await page.evaluate(
  ({ pw, layout }) => {
    if (pw) localStorage.setItem("house-viewer:access", JSON.stringify({ password: pw }));
    localStorage.setItem("house-viewer:pref:flyLayout", JSON.stringify(layout));
  },
  { pw: process.env.ACCESS_PASSWORD ?? "", layout: process.env.LAYOUT ?? "mono" },
);
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

await page.goto(`${base}/flythrough`);
await page.waitForSelector("canvas", { timeout: 60_000 }).catch(async (e) => {
  await page.screenshot({ path: `${out}/no-canvas.png`, fullPage: true });
  throw e;
});
await page.waitForTimeout(2500);
const duration = await page.$eval('input[aria-label="Position in the fly-through"]', (el) => Number(el.max));
console.log(`route: ${duration.toFixed(0)} s at 1×`);

const seek = (t) =>
  page.$eval(
    'input[aria-label="Position in the fly-through"]',
    (el, t) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, String(t));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    t,
  );

const times = (process.env.TIMES ?? "0,0.04,0.08,0.15,0.25,0.35,0.5,0.62,0.75,0.9,1").split(",").map(Number);
async function shoot(prefix) {
  for (const [i, f] of times.entries()) {
    await seek(f * duration);
    await page.waitForTimeout(700);
    const label = (await page.locator(".stage-title").innerText()).replace(/\s+/g, " ").trim();
    const name = `${prefix}-${String(i).padStart(2, "0")}`;
    await page.locator(".stage").screenshot({ path: `${out}/${name}.png` });
    console.log(`shot ${name} t=${(f * duration).toFixed(0)}s ${label}`);
  }
}
await shoot("fly");

// Look-around while playing: drag the view.
await seek(times.length > 3 ? times[3] * duration : 0);
await page.getByRole("button", { name: "Play" }).click();
const box = await page.locator(".stage canvas").boundingBox();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.45, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(800);
await page.locator(".stage").screenshot({ path: `${out}/look-around.png` });
await page.getByRole("button", { name: "Pause" }).click();

if (process.env.WALLS) {
  const btn = page.getByRole("button", { name: /^Fill \d+ room/ });
  console.log(await btn.innerText());
  await btn.click();
  await page.waitForSelector("text=All rooms filled", { timeout: 600_000 });
  await page.waitForTimeout(1500); // project save is debounced
  const art = await page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open("house-viewer", 1);
        r.onsuccess = () => (r.result.transaction("kv").objectStore("kv").get("project:current").onsuccess = (e) => res(e.target.result.wallArt));
      }),
  );
  writeFileSync(`${out}/wallart.json`, JSON.stringify(art));
  console.log(await page.locator(".cost-note").innerText().catch(() => ""));
  await page.waitForTimeout(2000);
  await shoot("walls");
}

await page.screenshot({ path: `${out}/page.png`, fullPage: true });
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no page errors");
await browser.close();
