/**
 * Sort every photo into rooms in one Gemini call, comparing the photos with
 * each other.
 *
 * Matching photos one at a time can't use the strongest cues a person uses:
 * listings show a room's photos next to each other, photos of the same room
 * share wall colour, flooring and ceiling shape, and two bedrooms are told
 * apart by comparing them, not by looking at one. Seeing everything at once
 * lets Gemini split or merge groups on that evidence. It's also far cheaper:
 * one reasoning pass instead of one per photo, with photos at medium
 * resolution (the plan stays at full detail).
 *
 * Photos the user placed by hand are sent as fixed: Gemini may say it
 * disagrees (shown as a suggestion) but never moves them.
 *
 * No camera poses here: judged across a whole listing they came back rough
 * (e.g. 90° off), and the per-room placement pass does that job well.
 */
import { normalizePhotoMatch } from "./room-graph";
import type { PhotoMatch, RoomGraph } from "./types";

/** Photos per call. ~60 KB each at 640 px keeps the body under Vercel's 4.5 MB limit. */
export const MAX_PHOTOS_PER_SORT = 36;

export interface SortPhotoInput {
  id: string;
  /** Caption or alt text from the listing, if any. */
  label?: string;
  /** Set when the user fixed this photo's room by hand. */
  fixedRoomId?: string | null;
  fixedExterior?: boolean;
}

export const SORT_SCHEMA = {
  type: "object",
  properties: {
    photos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          photo: { type: "integer", description: "photo number as labelled (1-based)" },
          appearance: {
            type: "string",
            description: "short visual signature: wall colour, flooring, ceiling shape (flat/vaulted/tray/beamed/sloped), standout fixtures",
          },
          roomId: { type: ["string", "null"], description: "id from the room list, or null if not an interior room photo / cannot tell" },
          isExterior: { type: "boolean", description: "true for exterior, yard, street, aerial or community-amenity photos" },
          confidence: { type: "number", description: "0..1 — how sure you are about roomId" },
          reasoning: { type: "string", description: "one sentence: the cues used, including which other photos it was grouped with or told apart from" },
        },
        required: ["photo", "appearance", "roomId", "isExterior", "confidence", "reasoning"],
      },
    },
    notes: { type: "string", description: "anything ambiguous: rooms that look alike, rooms with no photos, photos that don't fit the plan" },
  },
  required: ["photos"],
};

export function sortPrompt(graph: RoomGraph, photos: SortPhotoInput[], context: string[] = []): string {
  const rooms = graph.rooms
    .map((r) => `- ${r.id}: ${r.label} (${r.type})${r.sizeM ? `, ~${r.sizeM.width.toFixed(1)}×${r.sizeM.depth.toFixed(1)} m` : ""}, connects to [${r.neighbors.join(", ")}]`)
    .join("\n");
  const list = photos
    .map((p, i) => {
      const fixed = p.fixedExterior ? " — FIXED by the user: exterior" : p.fixedRoomId ? ` — FIXED by the user: ${p.fixedRoomId}` : "";
      return `- PHOTO ${i + 1}${p.label ? ` (caption: "${p.label.slice(0, 80)}")` : ""}${fixed}`;
    })
    .join("\n");
  return `These are all the photos from one home's real-estate listing, in the order the listing shows them, plus its floor plan.
Rooms on the floor plan:
${rooms}

Photos:
${list}
${context.length ? `\nAlready sorted in an earlier batch (no images here):\n${context.join("\n")}\n` : ""}
Sort every photo into the room it shows. Compare the photos with each other, not one at a time:
- Listings usually show a room's photos consecutively; a change of wall colour, flooring or ceiling usually means a new room.
- Photos of the same room share wall colour, trim, flooring, ceiling shape (flat, vaulted, tray, beamed, sloped), lighting fixtures and window style. Use that to group photos, and to split groups that look alike but differ (e.g. two bedrooms or two bathrooms).
- Match each group to a room on the plan using fixtures (sinks, tubs, appliances, beds), windows and doorways, and the room's size and neighbours. Captions help but can be wrong.
- Photos marked FIXED were placed by the user: keep that roomId unless you are very sure it's wrong, and use their look to anchor the others.
- Several rooms may have no photos; don't force a photo into a room just to fill it.
Be honest with confidence. Return only JSON matching the schema, with one entry per photo.`;
}

export interface SortResult {
  matches: PhotoMatch[];
  /** photoId → room Gemini would move a FIXED photo to. */
  disagreements: Record<string, string | null>;
  notes?: string;
}

export function normalizeSort(raw: unknown, photos: SortPhotoInput[], graph: RoomGraph): SortResult {
  const obj = (raw ?? {}) as { photos?: unknown; notes?: unknown };
  const seen = new Set<string>();
  const matches: PhotoMatch[] = [];
  const disagreements: Record<string, string | null> = {};
  for (const item of Array.isArray(obj.photos) ? obj.photos : []) {
    const p = (item ?? {}) as Record<string, unknown>;
    const n = typeof p.photo === "number" ? p.photo : NaN;
    if (!Number.isInteger(n) || n < 1 || n > photos.length) continue;
    const input = photos[n - 1];
    if (seen.has(input.id)) continue;
    seen.add(input.id);
    const m = normalizePhotoMatch(input.id, { ...p, headingDeg: null, cameraPosition: null }, graph);
    const appearance = typeof p.appearance === "string" ? p.appearance.trim() : "";
    const withLook = { ...m, appearance: appearance || undefined };
    if (input.fixedRoomId !== undefined || input.fixedExterior) {
      // Never override the user; just remember if Gemini would put it elsewhere.
      const fixed = input.fixedExterior ? null : input.fixedRoomId;
      const said = m.status === "exterior" ? null : m.roomId;
      if (said !== fixed && m.confidence >= 0.6 && (said || m.status === "exterior")) disagreements[input.id] = said;
      continue;
    }
    matches.push(withLook);
  }
  return { matches, disagreements, notes: typeof obj.notes === "string" ? obj.notes : undefined };
}

/** Split into near-equal batches, keeping listing order (neighbouring photos stay together). */
export function sortBatches<T>(items: T[]): T[][] {
  const n = Math.ceil(items.length / MAX_PHOTOS_PER_SORT);
  const size = Math.ceil(items.length / Math.max(1, n));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
