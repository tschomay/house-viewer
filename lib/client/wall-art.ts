/**
 * Client side of the AI wall art (lib/wall-art.ts): which rooms get it, what
 * each request says, and a cache so re-runs are free.
 */
import { roomWallInfo, type HouseModel } from "../house-model";
import type { GeminiUsage } from "../cost";
import type { ListingImage, PhotoMatch, WallArt } from "../types";
import { MAX_WALL_ART_PHOTOS, type WallArtRoom } from "../wall-art";
import { apiFetch } from "./access";
import { hashString } from "./hash";
import { cached } from "./idb";
import { redrawImage } from "./images";

/** 3.1 Flash Image: ~1120 image tokens at $60/M plus ~2k input tokens. */
export const WALL_ART_USD_PER_ROOM = 0.07;

const NO_ART_TYPES = new Set(["closet", "garage", "outdoor", "stairs"]);

export interface WallArtJob {
  roomId: string;
  label: string;
  imagined: boolean;
  room: WallArtRoom;
  photoIds: string[];
  key: string;
}

/** Up to `n` photos whose headings are as different as possible (so every wall gets seen). */
function spread<T extends { headingDeg: number }>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const out = [items[0]];
  const gap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
  while (out.length < n) {
    const rest = items.filter((i) => !out.includes(i));
    rest.sort((p, q) => Math.min(...out.map((o) => gap(o.headingDeg, q.headingDeg))) - Math.min(...out.map((o) => gap(o.headingDeg, p.headingDeg))));
    out.push(rest[0]);
  }
  return out;
}

export function wallArtJobs(model: HouseModel, matches: Record<string, PhotoMatch>, opts: { imagine: boolean; careful: boolean }): WallArtJob[] {
  const jobs: WallArtJob[] = [];
  const rooms = model.rooms.filter((r) => !r.parent);
  const housePhotos = rooms.flatMap((r) => r.photos);
  const houseStyle = [...new Set(Object.values(matches).map((m) => m.appearance).filter((a): a is string => !!a))];
  for (const r of rooms) {
    const walls = roomWallInfo(model, r.id);
    if (!walls) continue;
    const w = r.box.x1 - r.box.x0, d = r.box.z1 - r.box.z0;
    let photos = spread(r.photos, MAX_WALL_ART_PHOTOS);
    const imagined = !photos.length;
    if (imagined) {
      if (!opts.imagine || NO_ART_TYPES.has(r.type) || !housePhotos.length) continue;
      // Style references: photos from rooms next door, else from anywhere in the house.
      const near = housePhotos
        .slice()
        .sort((p, q) => Math.hypot(p.x - (r.box.x0 + w / 2), p.z - (r.box.z0 + d / 2)) - Math.hypot(q.x - (r.box.x0 + w / 2), q.z - (r.box.z0 + d / 2)));
      photos = near.slice(0, 2);
    }
    const room: WallArtRoom = {
      label: r.label,
      type: r.type,
      widthM: +w.toFixed(2),
      depthM: +d.toFixed(2),
      walls,
      photos: imagined
        ? []
        : photos.map((p) => ({
            headingDeg: p.headingDeg,
            x: +((p.x - r.box.x0) / w).toFixed(2),
            z: +((p.z - r.box.z0) / d).toFixed(2),
            note: matches[p.photoId]?.placementNote,
          })),
      imagined,
      style: imagined ? houseStyle.slice(0, 6) : [...new Set(photos.map((p) => matches[p.photoId]?.appearance).filter((a): a is string => !!a))],
    };
    const photoIds = photos.map((p) => p.photoId);
    jobs.push({ roomId: r.id, label: r.label, imagined, room, photoIds, key: `walls:v1:${hashString(JSON.stringify({ room, photoIds, careful: opts.careful }))}` });
  }
  return jobs;
}

/** A blank 4-strip template, the layout the image model is asked to fill. */
function template(): string {
  const c = document.createElement("canvas");
  c.width = 576;
  c.height = 1024;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = "#8a8a8a";
  g.lineWidth = 3;
  for (let i = 0; i < 4; i++) g.strokeRect(1.5, i * 256 + 1.5, c.width - 3, 253);
  return c.toDataURL("image/png");
}

export async function runWallArtJob(
  job: WallArtJob,
  photosById: Map<string, ListingImage>,
  careful: boolean,
): Promise<{ art: WallArt; usage: GeminiUsage | null }> {
  let usage: GeminiUsage | null = null;
  const res = await cached(job.key, async () => {
    const photos = await Promise.all(job.photoIds.map((id) => redrawImage(photosById.get(id)!.dataUrl, 768)));
    const r = await apiFetch("/api/wall-art", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: job.room, photos, template: template(), careful }),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(json.error ?? `HTTP ${r.status}`), { status: r.status });
    usage = json.usage ?? null;
    return { image: json.image as string, model: json.model as string };
  });
  return { art: { roomId: job.roomId, dataUrl: res.image, imagined: job.imagined, model: res.model, key: job.key }, usage };
}
