import { gated } from "@/lib/access";
import { FetchBlockedError, readLimited, safeFetch } from "@/lib/safe-fetch";

/**
 * Fetches a remote listing image server-side so the browser can draw it to a
 * canvas (listing CDNs rarely send CORS headers).
 */
export const GET = gated(async (req) => {
  const target = new URL(req.url).searchParams.get("url");
  if (!target) return new Response("missing url", { status: 400 });
  try {
    const res = await safeFetch(target, { headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.8" } });
    if (!res.ok) return new Response(`upstream HTTP ${res.status}`, { status: 502 });
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return new Response("not an image", { status: 415 });
    const body = await readLimited(res, 15 * 1024 * 1024);
    return new Response(body as BodyInit, {
      headers: { "content-type": type, "cache-control": "public, max-age=86400" },
    });
  } catch (e) {
    const status = e instanceof FetchBlockedError ? 400 : 502;
    return new Response((e as Error).message, { status });
  }
});
