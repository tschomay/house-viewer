import { gated } from "@/lib/access";
import { MissingKeyError, placePhotos } from "@/lib/gemini";
import { MAX_PHOTOS_PER_PLACEMENT, normalizePlacements } from "@/lib/placement";
import type { RoomGraph } from "@/lib/types";

export const maxDuration = 120;

/** One room (or a slice of a big room's photos) per request; the client downsizes photos to fit the body limit. */
export const POST = gated(async (req, creds) => {
  const body = (await req.json().catch(() => ({}))) as {
    roomId?: string;
    graph?: RoomGraph;
    photos?: { id: string; dataUrl: string }[];
    floorPlan?: string;
  };
  const room = body.graph?.rooms?.find((r) => r.id === body.roomId);
  if (!room || !body.graph || !body.floorPlan || !Array.isArray(body.photos) || !body.photos.length) {
    return Response.json({ error: "roomId, graph, photos and floorPlan are required" }, { status: 400 });
  }
  if (body.photos.length > MAX_PHOTOS_PER_PLACEMENT) {
    return Response.json({ error: `At most ${MAX_PHOTOS_PER_PLACEMENT} photos per request` }, { status: 400 });
  }
  try {
    const { raw, parsed, usage } = await placePhotos(creds.geminiKey, room, body.graph, body.photos.map((p) => p.dataUrl), body.floorPlan);
    const placements = normalizePlacements(parsed, body.photos.map((p) => p.id), room, body.graph);
    return Response.json({ raw, placements, usage });
  } catch (e) {
    const status = e instanceof MissingKeyError ? 503 : 502;
    console.error("[place-photos]", e);
    return Response.json({ error: (e as Error).message }, { status });
  }
});
