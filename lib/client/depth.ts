import type { DepthMap, ListingImage } from "../types";
import { apiFetch } from "./access";
import { cached, idbGet } from "./idb";
import { grayToDataUrl, readGray } from "./images";

export type DepthEngine = "browser" | "replicate" | "heuristic" | "truth";

type WorkerMsg =
  | { type: "progress"; file?: string; progress?: number }
  | { type: "result"; id: string; width: number; height: number; data: Uint8Array }
  | { type: "error"; id: string; error: string };

let worker: Worker | null = null;
const pending = new Map<string, { resolve: (d: { width: number; height: number; data: Uint8Array }) => void; reject: (e: Error) => void }>();
const progressListeners = new Set<(p: { file?: string; progress?: number }) => void>();

export function onModelProgress(fn: (p: { file?: string; progress?: number }) => void): () => void {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("../depth.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
    const msg = e.data;
    if (msg.type === "progress") progressListeners.forEach((fn) => fn(msg));
    else if (msg.type === "result") pending.get(msg.id)?.resolve(msg);
    else if (msg.type === "error") pending.get(msg.id)?.reject(new Error(msg.error));
    if (msg.type !== "progress") pending.delete(msg.id);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || "Depth worker crashed"));
    pending.clear();
    worker = null;
  };
  return worker;
}

// The worker handles one image at a time; queue so progress stays sane.
let queue: Promise<unknown> = Promise.resolve();

/** No result and no download progress for this long = the runtime is stuck (e.g. a missing WASM file). */
const STALL_MS = 60_000;

function browserDepth(image: ListingImage): Promise<{ width: number; height: number; data: Uint8Array }> {
  const run = () =>
    new Promise<{ width: number; height: number; data: Uint8Array }>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const stalled = () => {
        pending.delete(image.id);
        stopListening();
        worker?.terminate();
        worker = null;
        reject(new Error("The on-device depth model stopped responding"));
      };
      const bump = () => {
        clearTimeout(timer);
        timer = setTimeout(stalled, STALL_MS);
      };
      const stopListening = onModelProgress(bump);
      bump();
      pending.set(image.id, {
        resolve: (d) => {
          clearTimeout(timer);
          stopListening();
          resolve(d);
        },
        reject: (e) => {
          clearTimeout(timer);
          stopListening();
          reject(e);
        },
      });
      getWorker().postMessage({ id: image.id, dataUrl: image.dataUrl });
    });
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

async function replicateDepth(image: ListingImage): Promise<string> {
  const res = await apiFetch("/api/depth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: image.dataUrl }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(blob);
  });
}

/**
 * "Box room" prior: when no model is available, assume the camera is inside a
 * box — floor, ceiling and side walls are near, the centre of the frame is far.
 * Crude, but it gives a plausible stereo effect and keeps the pipeline usable.
 */
export function heuristicDepth(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const vy = Math.abs(y / (height - 1) - 0.52) / 0.48;
    const floorBias = y / height > 0.52 ? 1 : 0.8; // floor reads nearer than ceiling
    for (let x = 0; x < width; x++) {
      const vx = Math.abs(x / (width - 1) - 0.5) / 0.5;
      const near = Math.max(vy * floorBias, vx * 0.85);
      out[y * width + x] = Math.round(255 * Math.min(1, Math.pow(near, 1.6)));
    }
  }
  return out;
}

export async function estimateDepth(image: ListingImage, engine: DepthEngine): Promise<DepthMap> {
  if (engine === "truth") {
    const truth = await idbGet<DepthMap>(`depth:truth:${image.id}`);
    if (!truth) throw new Error("Ground-truth depth only exists for demo-house photos");
    return truth;
  }
  return cached(`depth:${engine}:${image.id}`, async () => {
    if (engine === "replicate") {
      const dataUrl = await replicateDepth(image);
      const { width, height } = await readGray(dataUrl, 1);
      return { photoId: image.id, width, height, dataUrl, source: "replicate" } satisfies DepthMap;
    }
    if (engine === "browser") {
      const { width, height, data } = await browserDepth(image);
      return { photoId: image.id, width, height, dataUrl: grayToDataUrl(width, height, data), source: "browser" } satisfies DepthMap;
    }
    const w = 256, h = Math.max(1, Math.round((256 * image.height) / image.width));
    return { photoId: image.id, width: w, height: h, dataUrl: grayToDataUrl(w, h, heuristicDepth(w, h)), source: "heuristic" } satisfies DepthMap;
  });
}
