import type { PhotoMatch, Room, RoomGraph } from "./types";
import { MATCH_CONFIDENCE_THRESHOLD } from "./types";

const clamp01 = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "room";
}

/**
 * Clean up whatever the model returned: unique ids, clamped centroids,
 * neighbor lists that only reference real rooms and are symmetric.
 */
export function normalizeRoomGraph(raw: unknown): RoomGraph {
  const obj = (raw ?? {}) as { rooms?: unknown[]; notes?: unknown };
  const rooms: Room[] = [];
  const idMap = new Map<string, string>();
  const seen = new Set<string>();

  for (const r of Array.isArray(obj.rooms) ? obj.rooms : []) {
    const room = (r ?? {}) as Record<string, unknown>;
    const label = typeof room.label === "string" && room.label.trim() ? room.label.trim() : "Room";
    const rawId = typeof room.id === "string" && room.id.trim() ? room.id.trim() : slug(label);
    let id = slug(rawId);
    for (let n = 2; seen.has(id); n++) id = `${slug(rawId)}_${n}`;
    seen.add(id);
    if (!idMap.has(rawId)) idMap.set(rawId, id);
    const c = (room.centroid ?? {}) as Record<string, unknown>;
    const b = room.bbox as Record<string, unknown> | null | undefined;
    const bbox =
      b && [b.x0, b.y0, b.x1, b.y1].every((v) => typeof v === "number" && Number.isFinite(v))
        ? {
            x0: clamp01(Math.min(b.x0 as number, b.x1 as number)),
            y0: clamp01(Math.min(b.y0 as number, b.y1 as number)),
            x1: clamp01(Math.max(b.x0 as number, b.x1 as number)),
            y1: clamp01(Math.max(b.y0 as number, b.y1 as number)),
          }
        : null;
    const size = room.sizeM as { width?: unknown; depth?: unknown } | null | undefined;
    rooms.push({
      id,
      label,
      type: typeof room.type === "string" ? room.type : "other",
      neighbors: (Array.isArray(room.neighbors) ? room.neighbors : []).filter((x): x is string => typeof x === "string"),
      centroid: { x: clamp01(c.x), y: clamp01(c.y) },
      bbox: bbox && bbox.x1 > bbox.x0 && bbox.y1 > bbox.y0 ? bbox : null,
      sizeM:
        size && typeof size.width === "number" && typeof size.depth === "number" && size.width > 0 && size.depth > 0
          ? { width: size.width, depth: size.depth }
          : null,
    });
  }

  const ids = new Set(rooms.map((r) => r.id));
  const resolve = (n: string) => idMap.get(n) ?? (ids.has(slug(n)) ? slug(n) : null);
  for (const room of rooms) {
    room.neighbors = [...new Set(room.neighbors.map(resolve).filter((n): n is string => !!n && n !== room.id))];
  }
  // Adjacency is symmetric: if A lists B, B gets A.
  const byId = new Map(rooms.map((r) => [r.id, r]));
  for (const room of rooms) {
    for (const n of room.neighbors) {
      const other = byId.get(n)!;
      if (!other.neighbors.includes(room.id)) other.neighbors.push(room.id);
    }
  }

  return { rooms, notes: typeof obj.notes === "string" ? obj.notes : undefined };
}

export function normalizePhotoMatch(photoId: string, raw: unknown, graph: RoomGraph): PhotoMatch {
  const m = (raw ?? {}) as Record<string, unknown>;
  const ids = new Set(graph.rooms.map((r) => r.id));
  const roomId = typeof m.roomId === "string" && ids.has(m.roomId) ? m.roomId : null;
  const confidence = clamp01(m.confidence);
  const heading = typeof m.headingDeg === "number" && Number.isFinite(m.headingDeg) ? ((m.headingDeg % 360) + 360) % 360 : null;
  const pos = m.cameraPosition as { x?: unknown; y?: unknown } | null | undefined;
  const isExterior = m.isExterior === true;

  let status: PhotoMatch["status"];
  if (isExterior && !roomId) status = "exterior";
  else if (!roomId) status = "unmatched";
  else if (confidence < MATCH_CONFIDENCE_THRESHOLD) status = "low-confidence";
  else status = "matched";

  return {
    photoId,
    roomId,
    confidence,
    headingDeg: heading,
    cameraPosition: pos && typeof pos.x === "number" && typeof pos.y === "number" ? { x: clamp01(pos.x), y: clamp01(pos.y) } : null,
    reasoning: typeof m.reasoning === "string" ? m.reasoning : "",
    status,
  };
}

/** Group photo ids by room. Low-confidence matches are still grouped (the UI flags them). */
export function groupByRoom(matches: PhotoMatch[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const m of matches) {
    const key = m.roomId ?? `_${m.status}`;
    (groups[key] ??= []).push(m.photoId);
  }
  return groups;
}

/**
 * Metres per normalized plan unit, separately for x and y (plan images aren't
 * square). Prefers rooms that have both a bbox and printed dimensions; falls
 * back to assuming the drawn footprint is ~14 m across.
 */
export function planScale(graph: RoomGraph, planAspect: number): { mx: number; my: number } {
  const xs: number[] = [], ys: number[] = [];
  for (const r of graph.rooms) {
    if (!r.bbox || !r.sizeM) continue;
    const w = r.bbox.x1 - r.bbox.x0, h = r.bbox.y1 - r.bbox.y0;
    if (w > 0.02) xs.push(r.sizeM.width / w);
    if (h > 0.02) ys.push(r.sizeM.depth / h);
  }
  const median = (a: number[]) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
  if (xs.length && ys.length) return { mx: median(xs), my: median(ys) };
  // planAspect = width / height in pixels; a normalized y unit is 1/aspect as long as an x unit.
  const bboxes = graph.rooms.map((r) => r.bbox).filter(Boolean) as NonNullable<Room["bbox"]>[];
  const span = bboxes.length ? Math.max(...bboxes.map((b) => b.x1)) - Math.min(...bboxes.map((b) => b.x0)) : 0.8;
  const mx = xs.length ? median(xs) : 14 / Math.max(0.2, span);
  return { mx, my: ys.length ? median(ys) : mx / planAspect };
}
