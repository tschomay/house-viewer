/**
 * Paint colours for the 3D house, sampled from the listing photos: floor from
 * the bottom of each frame, ceiling from the top, walls from a band just above
 * the middle. Used wherever neither a photo nor AI wall art covers a surface.
 * Free and on-device.
 */
import type { RoomColors } from "@/components/HouseFlythrough";
import type { HouseModel } from "../house-model";
import type { ListingImage } from "../types";
import { loadImage } from "./images";

const DEFAULTS: Record<string, RoomColors> = {
  bathroom: { wall: "#dfe3e2", floor: "#cfcbc3", ceiling: "#f1f1ee" },
  kitchen: { wall: "#e2ddd2", floor: "#a88a68", ceiling: "#f1f0ec" },
  laundry: { wall: "#dcdcd6", floor: "#c9c4ba", ceiling: "#f1f0ec" },
  bedroom: { wall: "#d8d6cf", floor: "#b8ad9c", ceiling: "#f1f0ec" },
  garage: { wall: "#c9c6bf", floor: "#9d9a94", ceiling: "#dcdad4" },
  default: { wall: "#dcd5c8", floor: "#9c8064", ceiling: "#f0efea" },
};

type RGB = [number, number, number];
const hex = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
const median = (a: number[]) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)] ?? 0;

async function sample(photo: ListingImage): Promise<{ wall: RGB; floor: RGB; ceiling: RGB } | null> {
  try {
    const img = await loadImage(photo.dataUrl);
    const w = 48, h = 36;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const band = (r0: number, r1: number, c0: number, c1: number): RGB => {
      const ch: number[][] = [[], [], []];
      for (let y = Math.floor(r0 * h); y < Math.ceil(r1 * h); y++)
        for (let x = Math.floor(c0 * w); x < Math.ceil(c1 * w); x++) for (let k = 0; k < 3; k++) ch[k].push(d[(y * w + x) * 4 + k]);
      return [median(ch[0]), median(ch[1]), median(ch[2])];
    };
    return { floor: band(0.84, 1, 0.2, 0.8), wall: band(0.28, 0.45, 0, 1), ceiling: band(0, 0.07, 0.2, 0.8) };
  } catch {
    return null;
  }
}

export async function roomPalette(model: HouseModel, photos: Map<string, ListingImage>): Promise<Record<string, RoomColors>> {
  const out: Record<string, RoomColors> = {};
  const measured = new Map<string, RoomColors>();
  for (const r of model.rooms) {
    const samples = (await Promise.all(r.photos.filter((p) => photos.has(p.photoId)).map((p) => sample(photos.get(p.photoId)!)))).filter(
      (s): s is NonNullable<typeof s> => !!s,
    );
    if (!samples.length) continue;
    const pick = (k: "wall" | "floor" | "ceiling"): RGB => [0, 1, 2].map((i) => median(samples.map((s) => s[k][i]))) as RGB;
    const ceil = pick("ceiling");
    // Ceilings photograph dark and blown-out by turns; keep them light and neutral.
    const lum = (ceil[0] + ceil[1] + ceil[2]) / 3;
    const ceiling: RGB = lum < 200 ? ([0, 1, 2].map((i) => ceil[i] + (235 - lum)) as RGB) : ceil;
    measured.set(r.id, { wall: hex(pick("wall")), floor: hex(pick("floor")), ceiling: hex(ceiling) });
  }
  for (const r of model.rooms) {
    const own = measured.get(r.id);
    if (own) {
      out[r.id] = own;
      continue;
    }
    // No photos: the nearest measured room on the same floor sets the style; its type sets the floor.
    const cx = (r.box.x0 + r.box.x1) / 2, cz = (r.box.z0 + r.box.z1) / 2;
    const near = model.rooms
      .filter((o) => o.floor === r.floor && measured.has(o.id))
      .sort((a, b) => Math.hypot((a.box.x0 + a.box.x1) / 2 - cx, (a.box.z0 + a.box.z1) / 2 - cz) - Math.hypot((b.box.x0 + b.box.x1) / 2 - cx, (b.box.z0 + b.box.z1) / 2 - cz))[0];
    const def = DEFAULTS[r.type] ?? DEFAULTS.default;
    out[r.id] = near ? { wall: measured.get(near.id)!.wall, floor: def.floor, ceiling: measured.get(near.id)!.ceiling } : def;
  }
  return out;
}
