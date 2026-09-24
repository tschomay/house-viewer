import { gated } from "@/lib/access";
import { generateWallArt, MissingKeyError } from "@/lib/gemini";
import { MAX_WALL_ART_PHOTOS, parseWallArtRoom } from "@/lib/wall-art";

export const maxDuration = 120;

const isImage = (s: unknown): s is string => typeof s === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(s) && s.length < 3_000_000;

/** One room per request: its photos (downsized by the client), a blank template, and the room's walls. */
export const POST = gated(async (req, creds) => {
  const body = (await req.json().catch(() => ({}))) as { room?: unknown; photos?: unknown[]; template?: unknown; careful?: boolean };
  const room = parseWallArtRoom(body.room);
  const photos = (Array.isArray(body.photos) ? body.photos : []).filter(isImage);
  if (!room || !isImage(body.template) || !photos.length) {
    return Response.json({ error: "room, photos and template are required" }, { status: 400 });
  }
  if (photos.length > MAX_WALL_ART_PHOTOS) return Response.json({ error: `At most ${MAX_WALL_ART_PHOTOS} photos per room` }, { status: 400 });
  try {
    const { dataUrl, usage, model } = await generateWallArt(creds.geminiKey, room, photos, body.template, body.careful === true);
    return Response.json({ image: dataUrl, usage, model });
  } catch (e) {
    const status = e instanceof MissingKeyError ? 503 : 502;
    console.error("[wall-art]", e);
    return Response.json({ error: (e as Error).message }, { status });
  }
});
