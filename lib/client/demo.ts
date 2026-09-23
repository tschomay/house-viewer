/**
 * A synthetic demo house, rendered in the browser with Three.js.
 *
 * Why: lets anyone try the whole tour (and lets us test depth → stereo →
 * multi-photo merge) with no API keys and no scraping, and it comes with
 * ground-truth room graph + camera poses to compare Gemini's output against.
 */
import * as THREE from "three";
import { DEFAULT_INTRINSICS, farFromRoomSize } from "../geometry";
import type { DepthMap, ListingImage, PhotoMatch, Room, RoomGraph } from "../types";
import { idbSet } from "./idb";
import { grayToDataUrl, toListingImage } from "./images";

interface DemoRoom {
  id: string;
  label: string;
  type: string;
  x0: number; z0: number; x1: number; z1: number; // metres
  wall: string;
  floor: "wood" | "tile" | "carpet";
}

const ROOMS: DemoRoom[] = [
  { id: "living", label: "Living Room", type: "living", x0: 0, z0: 0, x1: 6, z1: 5, wall: "#d9cbb3", floor: "wood" },
  { id: "kitchen", label: "Kitchen", type: "kitchen", x0: 6, z0: 0, x1: 11, z1: 4, wall: "#e8e4d8", floor: "tile" },
  { id: "dining", label: "Dining", type: "dining", x0: 6, z0: 4, x1: 11, z1: 7.5, wall: "#b9c7c4", floor: "wood" },
  { id: "hall", label: "Hall", type: "hallway", x0: 0, z0: 5, x1: 6, z1: 6.5, wall: "#ddd6c8", floor: "wood" },
  { id: "bedroom", label: "Bedroom", type: "bedroom", x0: 0, z0: 6.5, x1: 4, z1: 10, wall: "#c3cbd9", floor: "carpet" },
  { id: "bath", label: "Bath", type: "bathroom", x0: 4, z0: 6.5, x1: 6, z1: 10, wall: "#dfe9ec", floor: "tile" },
];

/** Openings between rooms: a segment on a shared wall. */
const DOORS: { a: string; b: string; axis: "x" | "z"; at: number; from: number; to: number }[] = [
  { a: "living", b: "kitchen", axis: "x", at: 6, from: 1, to: 3.6 }, // wide opening
  { a: "kitchen", b: "dining", axis: "z", at: 4, from: 6.5, to: 10.5 }, // open plan
  { a: "living", b: "hall", axis: "z", at: 5, from: 2, to: 3 },
  { a: "hall", b: "dining", axis: "x", at: 6, from: 5.3, to: 6.3 },
  { a: "hall", b: "bedroom", axis: "z", at: 6.5, from: 2.6, to: 3.5 },
  { a: "hall", b: "bath", axis: "z", at: 6.5, from: 4.5, to: 5.4 },
];

const WINDOWS: { axis: "x" | "z"; at: number; from: number; to: number }[] = [
  { axis: "z", at: 0, from: 1, to: 2.6 },
  { axis: "z", at: 0, from: 3.6, to: 5.2 },
  { axis: "z", at: 0, from: 7.5, to: 9.5 },
  { axis: "x", at: 11, from: 5, to: 6.8 },
  { axis: "x", at: 0, from: 7.5, to: 9 },
  { axis: "z", at: 10, from: 4.6, to: 5.4 },
];

/** Camera shots: position (m) and heading on the plan (0 = up/−Z, clockwise). */
const SHOTS: { room: string; x: number; z: number; heading: number }[] = [
  { room: "living", x: 5.3, z: 4.4, heading: 315 },
  { room: "living", x: 0.7, z: 4.3, heading: 45 },
  { room: "living", x: 3, z: 0.6, heading: 180 },
  { room: "kitchen", x: 6.6, z: 3.6, heading: 45 },
  { room: "kitchen", x: 10.4, z: 0.6, heading: 225 },
  { room: "dining", x: 6.6, z: 7, heading: 60 },
  { room: "hall", x: 0.5, z: 5.75, heading: 90 },
  { room: "bedroom", x: 3.5, z: 7, heading: 225 },
  { room: "bath", x: 5, z: 6.8, heading: 180 },
];

const PLAN_W = 11, PLAN_H = 10, PLAN_PAD = 0.6;
const planNorm = (x: number, z: number) => ({
  x: (x + PLAN_PAD) / (PLAN_W + 2 * PLAN_PAD),
  y: (z + PLAN_PAD) / (PLAN_H + 2 * PLAN_PAD),
});

function noiseTexture(base: string, kind: "wood" | "tile" | "carpet" | "wall" | "ceiling"): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  if (kind === "wood") {
    for (let y = 0; y < 256; y += 32) {
      g.fillStyle = `rgba(60,35,15,${0.08 + rnd() * 0.12})`;
      g.fillRect(0, y, 256, 32);
      g.fillStyle = "rgba(40,20,5,0.35)";
      g.fillRect(0, y, 256, 1.5);
      g.fillRect(rnd() * 256, y, 1.5, 32);
    }
  } else if (kind === "tile") {
    g.strokeStyle = "rgba(90,90,90,0.45)";
    g.lineWidth = 2;
    for (let i = 0; i <= 256; i += 64) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
    }
  }
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = `rgba(0,0,0,${rnd() * (kind === "carpet" ? 0.12 : 0.04)})`;
    g.fillRect(rnd() * 256, rnd() * 256, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function box(w: number, h: number, d: number, color: string | THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mat = typeof color === "string" ? new THREE.MeshStandardMaterial({ color, roughness: 0.85 }) : color;
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

/** Split [from,to] along a wall by the given openings. */
function subtract(from: number, to: number, holes: [number, number][]): [number, number][] {
  let segs: [number, number][] = [[from, to]];
  for (const [h0, h1] of holes) {
    segs = segs.flatMap(([a, b]) => {
      if (h1 <= a || h0 >= b) return [[a, b] as [number, number]];
      const out: [number, number][] = [];
      if (h0 > a) out.push([a, h0]);
      if (h1 < b) out.push([h1, b]);
      return out;
    });
  }
  return segs;
}

const H = 2.6, T = 0.06;

function buildScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#cfe3f5");
  scene.add(new THREE.HemisphereLight("#ffffff", "#8a7a66", 1.2));

  for (const r of ROOMS) {
    const w = r.x1 - r.x0, d = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const floorColor = r.floor === "wood" ? "#a0764a" : r.floor === "tile" ? "#d8d4cc" : "#8d8f99";
    const ft = noiseTexture(floorColor, r.floor);
    ft.repeat.set(w / 1.5, d / 1.5);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: ft, roughness: 0.7 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, cz);
    scene.add(floor);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: "#f4f2ee" }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, H, cz);
    scene.add(ceil);

    const wallTex = noiseTexture(r.wall, "wall");
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95 });
    const trim = new THREE.MeshStandardMaterial({ color: "#f7f5f0" });
    const holesFor = (axis: "x" | "z", at: number) => [
      ...DOORS.filter((dr) => (dr.a === r.id || dr.b === r.id) && dr.axis === axis && Math.abs(dr.at - at) < 1e-6).map(
        (dr) => [dr.from, dr.to] as [number, number],
      ),
    ];
    const walls: { axis: "x" | "z"; at: number; from: number; to: number; inward: number }[] = [
      { axis: "z", at: r.z0, from: r.x0, to: r.x1, inward: 1 },
      { axis: "z", at: r.z1, from: r.x0, to: r.x1, inward: -1 },
      { axis: "x", at: r.x0, from: r.z0, to: r.z1, inward: 1 },
      { axis: "x", at: r.x1, from: r.z0, to: r.z1, inward: -1 },
    ];
    for (const wl of walls) {
      const off = wl.at + (wl.inward * T) / 2;
      for (const [a, b] of subtract(wl.from, wl.to, holesFor(wl.axis, wl.at))) {
        const len = b - a, mid = (a + b) / 2;
        const win = WINDOWS.find((wd) => wd.axis === wl.axis && Math.abs(wd.at - wl.at) < 1e-6 && wd.from >= a && wd.to <= b);
        const add = (y0: number, y1: number, s0: number, s1: number) => {
          const l = s1 - s0, m = (s0 + s1) / 2, hy = y1 - y0;
          if (l <= 0 || hy <= 0) return;
          scene.add(wl.axis === "z" ? box(l, hy, T, wallMat, m, (y0 + y1) / 2, off) : box(T, hy, l, wallMat, off, (y0 + y1) / 2, m));
        };
        if (win) {
          add(0, H, a, win.from);
          add(0, H, win.to, b);
          add(0, 0.9, win.from, win.to);
          add(2.1, H, win.from, win.to);
          const glass = new THREE.MeshBasicMaterial({ color: "#eaf6ff" });
          const wl2 = win.to - win.from, wm = (win.from + win.to) / 2;
          scene.add(wl.axis === "z" ? box(wl2, 1.2, 0.01, glass, wm, 1.5, wl.at) : box(0.01, 1.2, wl2, glass, wl.at, 1.5, wm));
        } else add(0, H, a, b);
        // skirting board
        scene.add(wl.axis === "z" ? box(len, 0.1, T + 0.02, trim, mid, 0.05, off) : box(T + 0.02, 0.1, len, trim, off, 0.05, mid));
      }
    }
    const lamp = new THREE.PointLight("#fff4e0", 9, 12, 1.4);
    lamp.position.set(cx, H - 0.3, cz);
    scene.add(lamp);
  }

  // Furniture — mostly so depth maps have something to chew on.
  const wood = "#6b4a2e", fabric = "#4f6378", white = "#f2f2f0", steel = "#9aa1a8", dark = "#2e2f33";
  scene.add(box(2.4, 0.45, 0.9, fabric, 3, 0.225, 4.3), box(2.4, 0.5, 0.2, fabric, 3, 0.7, 4.7)); // sofa
  scene.add(box(1.2, 0.4, 0.6, wood, 3, 0.2, 2.9)); // coffee table
  scene.add(box(1.8, 0.6, 0.4, dark, 3, 0.3, 0.3), box(1.4, 0.8, 0.05, "#111", 3, 1.1, 0.3)); // tv
  scene.add(box(0.5, 1.8, 0.5, "#3c6e47", 0.5, 0.9, 0.5)); // plant
  scene.add(box(4.8, 0.9, 0.6, white, 8.6, 0.45, 0.3), box(4.8, 0.04, 0.62, "#3a3a3a", 8.6, 0.92, 0.3)); // counters
  scene.add(box(4.8, 0.7, 0.35, white, 8.6, 1.9, 0.18)); // uppers
  scene.add(box(0.8, 2, 0.7, steel, 10.55, 1, 0.4)); // fridge
  scene.add(box(2.2, 0.92, 1, white, 8.6, 0.46, 2.5), box(2.3, 0.04, 1.1, "#3a3a3a", 8.6, 0.94, 2.5)); // island
  scene.add(box(2, 0.05, 1, wood, 8.6, 0.75, 5.8), box(0.08, 0.72, 0.8, wood, 7.7, 0.36, 5.8), box(0.08, 0.72, 0.8, wood, 9.5, 0.36, 5.8)); // table
  for (const dx of [-0.6, 0.6]) for (const dz of [-0.75, 0.75]) scene.add(box(0.45, 0.9, 0.45, wood, 8.6 + dx, 0.45, 5.8 + dz));
  scene.add(box(1.6, 0.5, 2, "#e9e4da", 1.9, 0.25, 8.9), box(1.6, 1, 0.1, wood, 1.9, 0.5, 9.9)); // bed
  scene.add(box(0.5, 0.55, 0.45, wood, 0.6, 0.275, 9.6), box(0.9, 2, 0.6, wood, 0.45, 1, 7.4)); // nightstand, wardrobe
  scene.add(box(0.75, 0.55, 1.7, white, 5.6, 0.275, 9.1), box(0.9, 0.85, 0.5, white, 4.5, 0.425, 9.7)); // tub, vanity
  scene.add(box(0.8, 0.8, 0.02, "#bcd3e0", 4.5, 1.5, 9.93)); // mirror
  return scene;
}

function drawFloorPlan(): HTMLCanvasElement {
  const ppm = 60;
  const c = document.createElement("canvas");
  c.width = Math.round((PLAN_W + 2 * PLAN_PAD) * ppm);
  c.height = Math.round((PLAN_H + 2 * PLAN_PAD) * ppm);
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  const X = (x: number) => (x + PLAN_PAD) * ppm, Y = (z: number) => (z + PLAN_PAD) * ppm;
  g.strokeStyle = "#222";
  g.lineWidth = 6;
  g.lineCap = "square";
  for (const r of ROOMS) {
    const segs: { axis: "x" | "z"; at: number; from: number; to: number }[] = [
      { axis: "z", at: r.z0, from: r.x0, to: r.x1 },
      { axis: "z", at: r.z1, from: r.x0, to: r.x1 },
      { axis: "x", at: r.x0, from: r.z0, to: r.z1 },
      { axis: "x", at: r.x1, from: r.z0, to: r.z1 },
    ];
    for (const s of segs) {
      const holes = DOORS.filter((d) => d.axis === s.axis && Math.abs(d.at - s.at) < 1e-6).map((d) => [d.from, d.to] as [number, number]);
      for (const [a, b] of subtract(s.from, s.to, holes)) {
        g.beginPath();
        if (s.axis === "z") { g.moveTo(X(a), Y(s.at)); g.lineTo(X(b), Y(s.at)); }
        else { g.moveTo(X(s.at), Y(a)); g.lineTo(X(s.at), Y(b)); }
        g.stroke();
      }
    }
  }
  g.strokeStyle = "#6aa7d8";
  g.lineWidth = 4;
  for (const w of WINDOWS) {
    g.beginPath();
    if (w.axis === "z") { g.moveTo(X(w.from), Y(w.at)); g.lineTo(X(w.to), Y(w.at)); }
    else { g.moveTo(X(w.at), Y(w.from)); g.lineTo(X(w.at), Y(w.to)); }
    g.stroke();
  }
  g.fillStyle = "#222";
  g.textAlign = "center";
  const ft = (m: number) => { const inches = Math.round(m * 39.37); return `${Math.floor(inches / 12)}'${inches % 12}"`; };
  for (const r of ROOMS) {
    const cx = X((r.x0 + r.x1) / 2), cy = Y((r.z0 + r.z1) / 2);
    g.font = "bold 22px sans-serif";
    g.fillText(r.label.toUpperCase(), cx, cy);
    g.font = "17px sans-serif";
    g.fillText(`${ft(r.x1 - r.x0)} x ${ft(r.z1 - r.z0)}`, cx, cy + 24);
  }
  return c;
}

/**
 * Renders exact depth, encoded the way the pipeline decodes model output
 * (normalized inverse depth over [near, far]), so the demo can separate
 * "is the depth model good?" from "is the geometry right?".
 */
function truthDepthMaterial(near: number, far: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { near: { value: near }, far: { value: far } },
    vertexShader: `varying float vZ;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float near; uniform float far; varying float vZ;
      void main() { float d = clamp((1.0 / vZ - 1.0 / far) / (1.0 / near - 1.0 / far), 0.0, 1.0); gl_FragColor = vec4(vec3(d), 1.0); }`,
    side: THREE.DoubleSide,
  });
}

function canvasBlob(c: HTMLCanvasElement, type = "image/jpeg"): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), type, 0.92));
}

export const DEMO_LISTING_LABEL = "Demo: 1-bed synthetic house";

export function demoRoomGraph(): RoomGraph {
  const rooms: Room[] = ROOMS.map((r) => ({
    id: r.id,
    label: r.label,
    type: r.type,
    neighbors: DOORS.filter((d) => d.a === r.id || d.b === r.id).map((d) => (d.a === r.id ? d.b : d.a)),
    centroid: planNorm((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2),
    bbox: (() => {
      const a = planNorm(r.x0, r.z0), b = planNorm(r.x1, r.z1);
      return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    })(),
    sizeM: { width: r.x1 - r.x0, depth: r.z1 - r.z0 },
  }));
  return { rooms, notes: "Ground truth from the synthetic demo house (not from Gemini)." };
}

/** Render the demo house: floor plan + one photo per shot, with ground-truth matches. */
export async function buildDemo(onProgress?: (done: number, total: number) => void): Promise<{
  images: ListingImage[];
  graph: RoomGraph;
  matches: PhotoMatch[];
}> {
  const W = 1200, Hpx = 900;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = Hpx;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(W, Hpx, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = buildScene();
  const vfov = (2 * Math.atan(Math.tan((75 * Math.PI) / 360) / (W / Hpx)) * 180) / Math.PI;
  const camera = new THREE.PerspectiveCamera(vfov, W / Hpx, 0.05, 50);

  const images: ListingImage[] = [];
  const matches: PhotoMatch[] = [];
  const plan = await toListingImage(await canvasBlob(drawFloorPlan(), "image/png"), "floorplan", "upload", { label: "Demo floor plan" });
  images.push(plan);

  for (let i = 0; i < SHOTS.length; i++) {
    const s = SHOTS[i];
    camera.position.set(s.x, 1.5, s.z);
    // Level camera, as listing photographers shoot (and as the pipeline assumes).
    camera.rotation.set(0, (-s.heading * Math.PI) / 180, 0, "YXZ");
    renderer.render(scene, camera);
    const room = ROOMS.find((r) => r.id === s.room)!;
    const img = await toListingImage(await canvasBlob(canvas), "photo", "upload", { label: `${room.label} ${i + 1}` });
    images.push(img);

    // Ground-truth depth for the same view (tone mapping off so values survive exactly).
    const far = farFromRoomSize({ width: room.x1 - room.x0, depth: room.z1 - room.z0 });
    const depthMat = truthDepthMaterial(DEFAULT_INTRINSICS.near, far);
    scene.overrideMaterial = depthMat;
    const bg = scene.background;
    scene.background = new THREE.Color(0, 0, 0);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.render(scene, camera);
    const dw = 400, dh = 300;
    const small = document.createElement("canvas");
    small.width = dw;
    small.height = dh;
    const sctx = small.getContext("2d", { willReadFrequently: true })!;
    sctx.drawImage(canvas, 0, 0, dw, dh);
    const rgba = sctx.getImageData(0, 0, dw, dh).data;
    const gray = new Uint8Array(dw * dh);
    for (let k = 0; k < gray.length; k++) gray[k] = rgba[k * 4];
    const truth: DepthMap = { photoId: img.id, width: dw, height: dh, dataUrl: grayToDataUrl(dw, dh, gray), source: "truth" };
    await idbSet(`depth:truth:${img.id}`, truth);
    scene.overrideMaterial = null;
    scene.background = bg;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    depthMat.dispose();
    matches.push({
      photoId: img.id,
      roomId: s.room,
      confidence: 1,
      headingDeg: s.heading,
      cameraPosition: planNorm(s.x, s.z),
      reasoning: "Ground truth (demo house).",
      status: "matched",
    });
    onProgress?.(i + 1, SHOTS.length);
  }
  renderer.dispose();
  renderer.forceContextLoss();
  return { images, graph: demoRoomGraph(), matches };
}
