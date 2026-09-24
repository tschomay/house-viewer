import { gated } from "@/lib/access";
import { matchPhoto, MissingKeyError } from "@/lib/gemini";
import { normalizePhotoMatch } from "@/lib/room-graph";
import type { RoomGraph } from "@/lib/types";

export const maxDuration = 120;

/** One photo per request keeps each body well under Vercel's 4.5 MB limit. */
export const POST = gated(async (req, creds) => {
  const body = (await req.json().catch(() => ({}))) as {
    photoId?: string;
    photo?: string;
    graph?: RoomGraph;
    floorPlan?: string;
  };
  if (!body.photoId || !body.photo || !body.graph) {
    return Response.json({ error: "photoId, photo and graph are required" }, { status: 400 });
  }
  try {
    const { raw, parsed, usage } = await matchPhoto(creds.geminiKey, body.photo, body.graph, body.floorPlan);
    return Response.json({ raw, match: normalizePhotoMatch(body.photoId, parsed, body.graph), usage });
  } catch (e) {
    const status = e instanceof MissingKeyError ? 503 : 502;
    console.error("[match-photo]", e);
    return Response.json({ error: (e as Error).message }, { status });
  }
});
