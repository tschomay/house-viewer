import { gated } from "@/lib/access";
import { MissingKeyError, sortPhotos } from "@/lib/gemini";
import { MAX_PHOTOS_PER_SORT, normalizeSort, type SortPhotoInput } from "@/lib/sorting";
import type { RoomGraph } from "@/lib/types";

export const maxDuration = 300;

/** All of a listing's photos (up to MAX_PHOTOS_PER_SORT, downsized by the client) in one call. */
export const POST = gated(async (req, creds) => {
  const body = (await req.json().catch(() => ({}))) as {
    graph?: RoomGraph;
    photos?: (SortPhotoInput & { dataUrl: string })[];
    floorPlan?: string;
    context?: string[];
  };
  if (!body.graph?.rooms?.length || !Array.isArray(body.photos) || !body.photos.length) {
    return Response.json({ error: "graph and photos are required" }, { status: 400 });
  }
  if (body.photos.length > MAX_PHOTOS_PER_SORT) {
    return Response.json({ error: `At most ${MAX_PHOTOS_PER_SORT} photos per request` }, { status: 400 });
  }
  try {
    const context = Array.isArray(body.context) ? body.context.filter((c) => typeof c === "string").slice(0, 200) : [];
    const { raw, parsed, usage } = await sortPhotos(creds.geminiKey, body.graph, body.photos, body.floorPlan, context);
    return Response.json({ raw, ...normalizeSort(parsed, body.photos, body.graph), usage });
  } catch (e) {
    const status = e instanceof MissingKeyError ? 503 : 502;
    console.error("[sort-photos]", e);
    return Response.json({ error: (e as Error).message }, { status });
  }
});
