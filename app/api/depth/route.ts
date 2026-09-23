import { gated } from "@/lib/access";
import { replicateDepth } from "@/lib/depth";

export const maxDuration = 120;

/** Returns the depth map image bytes for one photo (data URL in the body). */
export const POST = gated(async (req, creds) => {
  const { image } = (await req.json().catch(() => ({}))) as { image?: string };
  if (!image) return Response.json({ error: "image (data URL) is required" }, { status: 400 });
  if (!creds.replicateToken) return Response.json({ error: "No Replicate token available" }, { status: 503 });
  try {
    const { bytes, contentType } = await replicateDepth(creds.replicateToken, image);
    return new Response(bytes, { headers: { "content-type": contentType } });
  } catch (e) {
    console.error("[depth]", e);
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
});
