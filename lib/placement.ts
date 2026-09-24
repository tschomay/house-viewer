/**
 * Second Gemini pass: place a room's cameras on the floor plan, judging all of
 * the room's photos together.
 *
 * The sort pass judges the whole listing at once and gives no camera poses,
 * and a manual room change throws away whatever pose a photo had. With the room settled, one call per room can compare the
 * photos with each other (photo 2 shows the doorway photo 1 was taken from),
 * which is what the 3D merge needs. It is also cheaper than re-matching: one
 * call per room, not one per photo.
 */
import type { PhotoMatch, PlanPoint, Room, RoomGraph } from "./types";

export interface Placement {
  photoId: string;
  headingDeg: number | null;
  cameraPosition: PlanPoint | null;
  confidence: number;
  /** False when the photo doesn't seem to show this room at all. */
  belongsHere: boolean;
  suggestedRoomId: string | null;
  note: string;
}

/** Photos per call. Keeps request bodies under Vercel's 4.5 MB limit and the prompt focused. */
export const MAX_PHOTOS_PER_PLACEMENT = 4;

export const PLACEMENT_SCHEMA = {
  type: "object",
  properties: {
    placements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          photo: { type: "integer", description: "photo number as labelled (1-based)" },
          belongsHere: { type: "boolean", description: "false if this photo does not show the outlined room" },
          betterRoomId: { type: ["string", "null"], description: "if belongsHere is false: id of the room it does show, else null" },
          cameraPosition: {
            type: ["object", "null"],
            description: "where the camera stands, normalized 0..1 floor-plan image coordinates from the top-left",
            properties: { x: { type: "number" }, y: { type: "number" } },
            required: ["x", "y"],
          },
          headingDeg: {
            type: ["number", "null"],
            description: "direction the camera faces on the plan: 0 = towards the top of the plan image, 90 = right, 180 = bottom, 270 = left",
          },
          confidence: { type: "number", description: "0..1, how sure you are about position and heading" },
          note: { type: "string", description: "one sentence: which walls, windows, doors or fixtures you matched to the plan" },
        },
        required: ["photo", "belongsHere", "cameraPosition", "headingDeg", "confidence", "note"],
      },
    },
  },
  required: ["placements"],
};

const side = (from: PlanPoint, to: PlanPoint) => {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy) * 1.5) return dx > 0 ? "right" : "left";
  if (Math.abs(dy) > Math.abs(dx) * 1.5) return dy > 0 ? "below" : "above";
  return `${dy > 0 ? "below" : "above"}-${dx > 0 ? "right" : "left"}`;
};

const f2 = (n: number) => n.toFixed(2);

/** A camera the user set by hand, by its photo number in the call. */
export interface FixedCamera {
  photo: number;
  x: number;
  y: number;
  headingDeg: number;
}

export function placementPrompt(room: Room, graph: RoomGraph, photoCount: number, fixed: FixedCamera[] = []): string {
  const b = room.bbox;
  const neighbors = room.neighbors
    .map((id) => graph.rooms.find((r) => r.id === id))
    .filter((r): r is Room => !!r)
    .map((r) => `${r.label} (${side(room.centroid, r.centroid)} on the plan)`);
  const others = graph.rooms.filter((r) => r.id !== room.id).map((r) => `${r.id} (${r.label})`);
  return `These ${photoCount} listing photo(s) were all taken in the ${room.label} (${room.type}), outlined in red on the floor plan.
${b ? `Its outline on the plan image spans x ${f2(b.x0)}–${f2(b.x1)}, y ${f2(b.y0)}–${f2(b.y1)} (normalized, origin top-left).` : `Its centre is at (${f2(room.centroid.x)}, ${f2(room.centroid.y)}).`}
${room.sizeM ? `Printed size: about ${room.sizeM.width.toFixed(1)} m wide (left–right on the plan) × ${room.sizeM.depth.toFixed(1)} m (top–bottom).` : ""}
Openings lead to: ${neighbors.join(", ") || "none listed"}.

For each photo, work out where the photographer stood and which way the camera faced, in floor-plan coordinates.
- Match what the photo shows to the plan: windows, doorways into the neighbouring rooms, closets, fixtures, and which walls are on the photo's left and right.
- Use the photos together: if one photo shows the doorway or corner another was taken from, their positions must agree. Photographers usually shoot from a corner or doorway, facing into the room, at about 1.5 m height.
- The camera stands inside the outline or in one of its doorways.${
    fixed.length
      ? `\n- The user set these cameras by hand. Treat them as correct, return them unchanged, and place the other photos consistently with them: ${fixed
          .map((c) => `PHOTO ${c.photo} at (${f2(c.x)}, ${f2(c.y)}) facing ${Math.round(c.headingDeg)}°`)
          .join("; ")}.`
      : ""
  }
- If a photo clearly does not show this room, set belongsHere to false and give betterRoomId from: ${others.join(", ") || "none"}.
Return only JSON matching the schema, with one entry per photo.`;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function normalizePlacements(raw: unknown, photoIds: string[], room: Room, graph: RoomGraph): Placement[] {
  const list = ((raw ?? {}) as { placements?: unknown }).placements;
  const ids = new Set(graph.rooms.map((r) => r.id));
  // Camera may stand in a doorway, so allow a little outside the outline.
  const b = room.bbox ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
  const mx = 0.25 * (b.x1 - b.x0) + 0.02, my = 0.25 * (b.y1 - b.y0) + 0.02;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.min(1, hi), Math.max(Math.max(0, lo), v));

  const out = new Map<string, Placement>();
  for (const item of Array.isArray(list) ? list : []) {
    const p = (item ?? {}) as Record<string, unknown>;
    const n = num(p.photo);
    if (n == null || !Number.isInteger(n) || n < 1 || n > photoIds.length) continue;
    const photoId = photoIds[n - 1];
    if (out.has(photoId)) continue;
    const pos = p.cameraPosition as { x?: unknown; y?: unknown } | null | undefined;
    const x = num(pos?.x), y = num(pos?.y);
    const heading = num(p.headingDeg);
    const belongsHere = p.belongsHere !== false;
    const better = typeof p.betterRoomId === "string" && ids.has(p.betterRoomId) && p.betterRoomId !== room.id ? p.betterRoomId : null;
    out.set(photoId, {
      photoId,
      belongsHere,
      suggestedRoomId: belongsHere ? null : better,
      headingDeg: heading == null ? null : ((heading % 360) + 360) % 360,
      cameraPosition: x != null && y != null ? { x: clamp(x, b.x0 - mx, b.x1 + mx), y: clamp(y, b.y0 - my, b.y1 + my) } : null,
      confidence: Math.min(1, Math.max(0, num(p.confidence) ?? 0.5)),
      note: typeof p.note === "string" ? p.note : "",
    });
  }
  return photoIds.map((id) => out.get(id)).filter((p): p is Placement => !!p);
}

/** Fold a placement into the photo's match. Room choice, confidence and the manual flag are kept. */
export function applyPlacement(match: PhotoMatch, p: Placement): PhotoMatch {
  // A camera set by hand wins; keep only Gemini's note and any room doubt.
  if (match.manualPose) return { ...match, placementNote: p.note, suggestedRoomId: p.suggestedRoomId };
  const usable = p.belongsHere && p.headingDeg != null;
  return {
    ...match,
    headingDeg: usable ? p.headingDeg : match.headingDeg,
    cameraPosition: usable ? p.cameraPosition ?? match.cameraPosition : match.cameraPosition,
    placed: usable,
    placementNote: p.note,
    suggestedRoomId: p.suggestedRoomId,
  };
}

/** Split a room's photos into placement calls. */
export function placementBatches<T>(items: T[]): T[][] {
  const n = Math.ceil(items.length / MAX_PHOTOS_PER_PLACEMENT);
  const size = Math.ceil(items.length / Math.max(1, n));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
