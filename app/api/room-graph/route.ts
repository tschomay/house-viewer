import { gated } from "@/lib/access";
import { extractRoomGraph, MissingKeyError } from "@/lib/gemini";
import { normalizeRoomGraph } from "@/lib/room-graph";

export const maxDuration = 120;

export const POST = gated(async (req, creds) => {
  const { floorPlan, levels } = (await req.json().catch(() => ({}))) as { floorPlan?: string; levels?: number };
  if (!floorPlan) return Response.json({ error: "floorPlan (data URL) is required" }, { status: 400 });
  try {
    const { raw, parsed, usage } = await extractRoomGraph(creds.geminiKey, floorPlan, typeof levels === "number" ? levels : 1);
    const graph = normalizeRoomGraph(parsed);
    console.log("[room-graph] raw Gemini output:", raw);
    return Response.json({ raw, graph, usage });
  } catch (e) {
    const status = e instanceof MissingKeyError ? 503 : 502;
    console.error("[room-graph]", e);
    return Response.json({ error: (e as Error).message }, { status });
  }
});
