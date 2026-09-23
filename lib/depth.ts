import "server-only";

/**
 * Optional server-side depth via Replicate. The default path runs Depth
 * Anything V2 in the browser (lib/depth-client.ts); this exists for when the
 * larger model is wanted or the device is too slow.
 */
export const DEPTH_MODEL = process.env.REPLICATE_DEPTH_MODEL ||
  "chenxwh/depth-anything-v2:b239ea33cff32bb7abb5db39ffe9a09c14cbc2894331d1ef66fe096eed88ebd4";

const API = "https://api.replicate.com/v1";

async function rpc(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Replicate ${path} → HTTP ${res.status}: ${json.detail ?? JSON.stringify(json)}`);
  return json;
}

let cachedVersion: string | null = null;

async function resolveVersion(token: string): Promise<string> {
  const [name, pinned] = DEPTH_MODEL.split(":");
  if (pinned) return pinned;
  if (cachedVersion) return cachedVersion;
  const model = await rpc(token, `/models/${name}`);
  cachedVersion = model?.latest_version?.id;
  if (!cachedVersion) throw new Error(`No version found for ${name}`);
  return cachedVersion!;
}

/** Pick the grayscale depth URL out of whatever shape the model returns. */
export function pickDepthUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map(pickDepthUrl).find(Boolean) ?? null;
  if (output && typeof output === "object") {
    const entries = Object.entries(output as Record<string, unknown>).filter(([, v]) => typeof v === "string");
    const grey = entries.find(([k]) => /gr[ae]y/i.test(k)) ?? entries.find(([k]) => !/colou?r/i.test(k)) ?? entries[0];
    return (grey?.[1] as string) ?? null;
  }
  return null;
}

export async function replicateDepth(token: string, imageDataUrl: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  let prediction = await rpc(token, "/predictions", {
    method: "POST",
    headers: { prefer: "wait=55" },
    body: JSON.stringify({ version: await resolveVersion(token), input: { image: imageDataUrl, model_size: "Large" } }),
  });
  const deadline = Date.now() + 110_000;
  while (!["succeeded", "failed", "canceled"].includes(prediction.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    prediction = await rpc(token, `/predictions/${prediction.id}`);
  }
  if (prediction.status !== "succeeded") throw new Error(`Depth prediction ${prediction.status}: ${prediction.error ?? ""}`);
  const url = pickDepthUrl(prediction.output);
  if (!url) throw new Error("Depth model returned no image");
  const img = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return { bytes: await img.arrayBuffer(), contentType: img.headers.get("content-type") ?? "image/png" };
}
