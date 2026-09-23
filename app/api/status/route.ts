import { AccessError, authorize, gateConfig } from "@/lib/access";
import { GEMINI_MODEL } from "@/lib/gemini";
import { DEPTH_MODEL } from "@/lib/depth";

/**
 * What's available to *this* caller: checks the access headers it sends.
 * Never returns keys.
 */
export async function GET(req: Request) {
  let access: { ok: boolean; via?: string; error?: string };
  let gemini = false, replicate = false;
  try {
    const creds = await authorize(req);
    access = { ok: true, via: creds.via };
    gemini = Boolean(creds.geminiKey);
    replicate = Boolean(creds.replicateToken);
  } catch (e) {
    access = { ok: false, error: e instanceof AccessError ? e.message : "error" };
  }
  return Response.json({ access, gate: gateConfig(), gemini, geminiModel: GEMINI_MODEL, replicate, depthModel: DEPTH_MODEL });
}
