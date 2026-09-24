/**
 * AI wall art for the 3D house: one image per room, four horizontal strips,
 * one flat elevation per wall (top, right, bottom, left as drawn on the plan).
 *
 * The listing photos are projected onto the walls wherever they can see; this
 * fills the rest, so the model isn't bare paint behind the camera. One image
 * per room (not one per wall) keeps it at ~$0.07 a room on 3.1 Flash Image.
 * Rooms without any photos can be "imagined" from the rest of the house: those
 * are marked as invented in the viewer.
 */
import type { Side } from "./house-model";

export const WALL_ART_STRIPS: Side[] = ["top", "right", "bottom", "left"];
/** Output aspect: 4 strips of 9:4 each, close to a typical 5 m × 2.6 m wall. */
export const WALL_ART_ASPECT = "9:16";
export const MAX_WALL_ART_PHOTOS = 4;

export interface WallArtWall {
  side: Side;
  lengthM: number;
  exterior: boolean;
  openings: { from: number; to: number; kind: string; to_room: string }[];
}

export interface WallArtRoom {
  label: string;
  type: string;
  widthM: number;
  depthM: number;
  walls: WallArtWall[];
  /** Photos of this room, in the order they're attached: where each was taken (0..1 across the room) and which way it faced. */
  photos: { headingDeg: number; x: number; z: number; note?: string }[];
  /** No photos of this room: invent it in the style of the attached photos from elsewhere in the house. */
  imagined?: boolean;
  /** Appearance notes from the photo sort, for context. */
  style?: string[];
}

const SIDE_NAME: Record<Side, string> = {
  top: "TOP wall (the wall toward the top of the floor plan)",
  right: "RIGHT wall (toward the plan's right)",
  bottom: "BOTTOM wall (toward the plan's bottom)",
  left: "LEFT wall (toward the plan's left)",
};

const pct = (f: number) => `${Math.round(f * 100)}%`;

function facing(h: number): string {
  const names = ["TOP", "TOP/RIGHT corner", "RIGHT", "BOTTOM/RIGHT corner", "BOTTOM", "BOTTOM/LEFT corner", "LEFT", "TOP/LEFT corner"];
  return names[Math.round((((h % 360) + 360) % 360) / 45) % 8];
}

export function wallArtPrompt(room: WallArtRoom): string {
  const walls = WALL_ART_STRIPS.map((side, i) => {
    const w = room.walls.find((x) => x.side === side);
    if (!w) return `Strip ${i + 1}: ${SIDE_NAME[side]}.`;
    const holes = w.openings.length
      ? w.openings
          .map((o) =>
            o.kind === "front"
              ? `the front door from ${pct(o.from)} to ${pct(o.to)} across`
              : o.kind === "open"
                ? `a wide opening into the ${o.to_room} from ${pct(o.from)} to ${pct(o.to)} across`
                : `a doorway to the ${o.to_room} from ${pct(o.from)} to ${pct(o.to)} across`,
          )
          .join("; ")
      : "no doorways";
    return `Strip ${i + 1}: ${SIDE_NAME[side]}, ${w.lengthM.toFixed(1)} m long${w.exterior ? ", an outside wall (windows are likely)" : ""}; ${holes}.`;
  }).join("\n");

  const photoLines = room.photos
    .map(
      (p, i) =>
        `Photo ${i + 1}: taken from ${pct(p.x)} across and ${pct(p.z)} down the room (as drawn on the plan), facing the ${facing(p.headingDeg)} wall.${p.note ? ` ${p.note}` : ""}`,
    )
    .join("\n");

  const source = room.imagined
    ? `There are NO photos of this ${room.type} (the "${room.label}"). The attached photos show OTHER rooms of the same house: invent a plausible, modest ${room.type} in the same style (paint, trim, doors, flooring era). Do not copy furniture from them.`
    : `The attached photos all show this ${room.type} (the "${room.label}"), about ${room.widthM.toFixed(1)} m wide (left-right on the plan) by ${room.depthM.toFixed(1)} m deep.\n${photoLines}`;

  return `${source}
${room.style?.length ? `Notes on the house's look: ${room.style.slice(0, 6).join("; ")}.\n` : ""}
Make texture maps for a 3D model of this room. Fill the TEMPLATE image: its 4 stacked horizontal strips are the room's 4 walls, each seen from inside the room:
${walls}
"Across" runs left to right as you stand in the room facing that wall.

Each strip is a FLAT ORTHOGRAPHIC ELEVATION of one wall only, like an architect's elevation drawing but photorealistic: the wall's left corner exactly at the strip's left edge, its right corner exactly at the right edge, the floor line exactly at the strip's bottom edge and the ceiling line exactly at its top edge. No perspective, no vanishing lines, no visible ceiling, floor or side walls. Even, soft lighting.
Show only what is fixed to the wall: paint colour, trim and baseboards, windows, doors and openings, built-in cabinets and counters, fireplace, fixtures. Leave out free-standing furniture, rugs, people and clutter. Where the photos don't show a wall, continue the room's real style plausibly; never contradict the photos.
Keep the 4-strip layout exactly, strips the same height, with no labels, text, captions or borders in the output.`;
}

/** Checks a client-sent room description (the route trusts nothing). */
export function parseWallArtRoom(raw: unknown): WallArtRoom | null {
  const r = raw as Partial<WallArtRoom> | null;
  if (!r || typeof r.label !== "string" || typeof r.type !== "string") return null;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  const walls = (Array.isArray(r.walls) ? r.walls : [])
    .filter((w): w is WallArtWall => !!w && WALL_ART_STRIPS.includes((w as WallArtWall).side))
    .slice(0, 4)
    .map((w) => ({
      side: w.side,
      lengthM: num(w.lengthM, 0.3, 40, 4),
      exterior: w.exterior === true,
      openings: (Array.isArray(w.openings) ? w.openings : []).slice(0, 6).map((o) => ({
        from: num(o?.from, 0, 1, 0),
        to: num(o?.to, 0, 1, 0),
        kind: ["door", "open", "front"].includes(o?.kind) ? o.kind : "door",
        to_room: str(o?.to_room, 60) || "next room",
      })),
    }));
  return {
    label: str(r.label, 60) || "Room",
    type: str(r.type, 30) || "room",
    widthM: num(r.widthM, 0.3, 40, 4),
    depthM: num(r.depthM, 0.3, 40, 4),
    walls,
    photos: (Array.isArray(r.photos) ? r.photos : []).slice(0, MAX_WALL_ART_PHOTOS).map((p) => ({
      headingDeg: num(p?.headingDeg, -720, 720, 0),
      x: num(p?.x, 0, 1, 0.5),
      z: num(p?.z, 0, 1, 0.5),
      note: str(p?.note, 300) || undefined,
    })),
    imagined: r.imagined === true,
    style: (Array.isArray(r.style) ? r.style : []).filter((s) => typeof s === "string").slice(0, 8).map((s) => s.slice(0, 120)),
  };
}
