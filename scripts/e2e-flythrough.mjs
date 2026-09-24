// 3D fly-through smoke test: load a project (or the demo house), open /flythrough, screenshot along the route.
// Usage: node scripts/e2e-flythrough.mjs [baseUrl] [outDir]
//   PROJECT=path/to/export.json   load a project export instead of the demo house
//   WALLS=1                       also run the AI wall fill (costs ≈$0.07 a room) and re-shoot
//   ACCESS_PASSWORD=...           needed for WALLS=1 when the server has a password
//   LAYOUT=mono|cross|parallel    stereo layout (default mono)
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
  console.log(await page.locator(".cost-note").innerText().catch(() => ""));
  await page.waitForTimeout(2000);
  await shoot("walls");
}

await page.screenshot({ path: `${out}/page.png`, fullPage: true });
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no page errors");
await browser.close();
