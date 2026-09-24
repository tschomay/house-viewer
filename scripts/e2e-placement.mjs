// Multi-photo placement check on the demo house, against its ground-truth camera poses.
// Usage: MODE=perturb|gemini DEPTH_ENGINE=truth|browser ACCESS_PASSWORD=... node scripts/e2e-placement.mjs [baseUrl]
//   perturb: Gemini-sized errors (±25°, ~0.7 m) are added to the true poses; no API calls.
//   gemini:  camera poses are wiped (as after manual room picks), then "Place cameras" runs for real (6 calls, ≈$0.1–0.2).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${process.execPath.replace(/bin\/node$/, "")}lib/node_modules/playwright`);
}

const base = process.argv[2] ?? "http://localhost:3000";
const mode = process.env.MODE ?? "perturb";
const engine = process.env.DEPTH_ENGINE ?? "truth";

// Mirrors lib/client/demo.ts.
const ROOMS = {
  "Living Room": { x0: 0, z0: 0, x1: 6, z1: 5 },
  Kitchen: { x0: 6, z0: 0, x1: 11, z1: 4 },
  Dining: { x0: 6, z0: 4, x1: 11, z1: 7.5 },
  Hall: { x0: 0, z0: 5, x1: 6, z1: 6.5 },
  Bedroom: { x0: 0, z0: 6.5, x1: 4, z1: 10 },
  Bath: { x0: 4, z0: 6.5, x1: 6, z1: 10 },
};
const SHOTS = [
  ["Living Room", 5.3, 4.4, 315], ["Living Room", 0.7, 4.3, 45], ["Living Room", 3, 0.6, 180],
  ["Kitchen", 6.6, 3.6, 45], ["Kitchen", 10.4, 0.6, 225], ["Dining", 6.6, 7, 60],
  ["Hall", 0.5, 5.75, 90], ["Bedroom", 3.5, 7, 225], ["Bath", 5, 6.8, 180],
];
const PLAN = { w: 11 + 1.2, h: 10 + 1.2, pad: 0.6 };
const truthFor = (label) => {
  const i = Number(label.split(" ").at(-1)) - 1;
  const [room, x, z, heading] = SHOTS[i];
  const r = ROOMS[room];
  return { room, x, z, heading, tx: x - (r.x0 + r.x1) / 2, tz: z - (r.z0 + r.z1) / 2, yaw: (-heading * Math.PI) / 180 };
};
const angErr = (a, b) => Math.abs(((((a - b) * 180) / Math.PI) % 360 + 540) % 360 - 180);

const browser = await playwright.chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--ignore-certificate-errors"],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
if (process.env.ACCESS_PASSWORD) {
  await ctx.addInitScript((pw) => localStorage.setItem("house-viewer:access", JSON.stringify({ password: pw })), process.env.ACCESS_PASSWORD);
}
const page = await ctx.newPage();
const modelLines = [];
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error") errors.push(t);
  if (t.startsWith("[room-model] ")) modelLines.push(t);
  if (process.env.VERBOSE) console.log(`[${m.type()}] ${t}`);
});

const editProject = (fn) =>
  page.evaluate(async (src) => {
    const edit = new Function(`return (${src})`)();
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("house-viewer", 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const store = () => db.transaction("kv", "readwrite").objectStore("kv");
    const project = await new Promise((res) => (store().get("project:current").onsuccess = (e) => res(e.target.result)));
    edit(project);
    await new Promise((res) => (store().put(project, "project:current").onsuccess = res));
  }, fn.toString());

await page.goto(base);
await page.getByRole("button", { name: "Try the demo house" }).first().click();
await page.waitForURL("**/analyze", { timeout: 120_000 });
await page.waitForSelector("text=6 rooms");
await page.waitForTimeout(1500); // let the project autosave

if (mode === "perturb") {
  await editProject((p) => {
    let k = 0;
    for (const m of Object.values(p.matches)) {
      const s = k++ % 2 ? 1 : -1;
      m.headingDeg = (m.headingDeg + 25 * s + 360) % 360;
      m.cameraPosition = { x: m.cameraPosition.x + 0.045 * s, y: m.cameraPosition.y - 0.04 };
      m.confidence = 0.8;
    }
  });
} else {
  await editProject((p) => {
    for (const m of Object.values(p.matches)) Object.assign(m, { headingDeg: null, cameraPosition: null, manual: true, reasoning: "Assigned by you." });
  });
}
await page.reload();
await page.waitForSelector("text=6 rooms");

if (mode === "gemini") {
  const t0 = Date.now();
  await page.getByRole("button", { name: "Place cameras" }).click();
  await page.waitForSelector(".match-room .spinner", { timeout: 10_000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector(".match-room .spinner"), null, { timeout: 300_000 });
  console.log(`placement took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("cost:", await page.locator(".cost-note").first().innerText().catch(() => "?"));
  await page.waitForTimeout(1500);
  const matches = await page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open("house-viewer", 1);
        r.onsuccess = () => (r.result.transaction("kv").objectStore("kv").get("project:current").onsuccess = (e) => res(e.target.result));
      }),
  );
  const label = Object.fromEntries(matches.images.map((i) => [i.id, i.label]));
  console.log("\nGemini placement vs truth (plan):");
  for (const m of Object.values(matches.matches)) {
    const t = truthFor(label[m.photoId]);
    const pos = m.cameraPosition && { x: m.cameraPosition.x * PLAN.w - PLAN.pad, z: m.cameraPosition.y * PLAN.h - PLAN.pad };
    console.log(
      `  ${label[m.photoId].padEnd(14)} placed=${!!m.placed} heading ${m.headingDeg ?? "–"} (true ${t.heading}, err ${
        m.headingDeg == null ? "–" : angErr((m.headingDeg * Math.PI) / 180, (t.heading * Math.PI) / 180).toFixed(0)
      }°) pos err ${pos ? Math.hypot(pos.x - t.x, pos.z - t.z).toFixed(2) + " m" : "–"}${m.suggestedRoomId ? ` suggests ${m.suggestedRoomId}` : ""}`,
    );
  }
}

await page.locator("select.input").selectOption(engine);
await page.getByRole("button", { name: "Estimate depth" }).click();
await page.waitForFunction(() => /9\/9 photos/.test(document.body.innerText), null, { timeout: 900_000 });

await page.getByRole("link", { name: "Start tour →" }).click();
await page.waitForURL("**/tour");
await page.waitForFunction(() => document.querySelector(".controls .row.small"), null, { timeout: 60_000 });
await page.getByRole("button", { name: "Kitchen →" }).click();
await page.waitForTimeout(4000);
console.log("\nstatus (kitchen):", await page.locator(".controls .row.small").innerText().catch(() => "?"));

console.log(`\nFinal poses vs truth (mode=${mode}, depth=${engine}):`);
const models = new Map();
for (const t of modelLines) {
  const hit = t.match(/^\[room-model\] (\S+) (.*)$/s);
  try {
    models.set(hit[1], JSON.parse(hit[2]));
  } catch (e) {
    console.log(`unparsed room-model line (${e.message}): ${t.slice(0, 120)}`);
  }
}
if (!models.size) console.log(`no multi-photo room models logged (${modelLines.length} lines)`);
for (const [room, layers] of models) {
  for (const l of layers) {
    const t = truthFor(l.id);
    console.log(
      `  ${room.padEnd(8)} ${l.id.padEnd(14)} yaw err ${angErr(l.pose.yaw, t.yaw).toFixed(1).padStart(5)}°  pos err ${Math.hypot(l.pose.tx - t.tx, l.pose.tz - t.tz).toFixed(2)} m  scale ${l.pose.scale.toFixed(2)}  outline ${l.outline ?? "–"}  calib far ${l.calib}  reg ${l.reg}`,
    );
  }
}
await browser.close();
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no page errors");
