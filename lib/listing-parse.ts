/**
 * Pure HTML → image list extraction for listing pages. Kept free of network
 * code so it can be unit-tested against saved pages.
 *
 * Strategy, most to least reliable:
 *  1. JSON-LD (`schema.org` RealEstateListing / Product / Residence `image`)
 *  2. `og:image` / `twitter:image` meta tags
 *  3. `<img>` src / data-src / srcset
 *  4. Any absolute image URL embedded in inline JSON (Zillow/Redfin ship their
 *     photo lists inside hydration blobs)
 */

export interface FoundImage {
  url: string;
  alt?: string;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|avif)(\?|$)/i;
const JUNK = /(logo|icon|sprite|avatar|favicon|badge|agent|headshot|placeholder|pixel|tracking|staticmap|maps\.googleapis|\.svg)/i;
const FLOORPLAN = /floor[\s_-]?plan|site[\s_-]?plan/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/");
}

function absolutize(raw: string, base: string): string | null {
  try {
    const u = new URL(decodeEntities(raw.trim()), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Same photo at different sizes → same key, so we keep one (the largest). */
export function dedupKey(url: string): string {
  const u = url.split("?")[0].split("#")[0];
  return u
    .replace(/[-_](cc_ft_|p_|uncropped_scaled_within_|h_|w_)?\d{2,4}(x\d{2,4})?(?=\.\w+$)/i, "")
    .replace(/\/(\d{2,4}x\d{2,4}|w\d{2,4}|h\d{2,4})\//i, "/")
    .toLowerCase();
}

function sizeHint(url: string): number {
  const nums = (url.split("?")[0].match(/\d{3,4}/g) ?? []).map(Number).filter((n) => n <= 4096);
  return nums.length ? Math.max(...nums) : 0;
}

function collectJsonLdImages(node: unknown, out: FoundImage[], floorPlanHint = false): void {
  if (!node) return;
  if (typeof node === "string") {
    if (/^https?:\/\//.test(node)) out.push({ url: node, alt: floorPlanHint ? "floor plan" : undefined });
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) collectJsonLdImages(n, out, floorPlanHint);
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const alt = [obj.caption, obj.name, obj.description].find((v) => typeof v === "string") as string | undefined;
    for (const key of ["contentUrl", "url"]) {
      const v = obj[key];
      if (typeof v === "string" && IMAGE_EXT.test(v) && obj["@type"] === "ImageObject") {
        out.push({ url: v, alt: floorPlanHint ? `floor plan ${alt ?? ""}`.trim() : alt });
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === "image" || k === "photo" || k === "photos" || k === "associatedMedia") collectJsonLdImages(v, out, floorPlanHint);
      else if (/floorplan/i.test(k)) collectJsonLdImages(v, out, true);
      else if (typeof v === "object") collectJsonLdImages(v, out, floorPlanHint);
    }
  }
}

export function extractListingImages(html: string, baseUrl: string): { photos: FoundImage[]; floorPlans: FoundImage[] } {
  const found: FoundImage[] = [];

  // 1. JSON-LD
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collectJsonLdImages(JSON.parse(m[1]), found);
    } catch {
      /* malformed JSON-LD is common; ignore */
    }
  }

  // 2. meta tags
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::url)?["'][^>]*>/gi)) {
    const content = m[0].match(/content=["']([^"']+)["']/i);
    if (content) found.push({ url: content[1] });
  }

  // 3. <img>
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1];
    for (const attr of ["src", "data-src", "data-lazy-src", "data-original"]) {
      const v = tag.match(new RegExp(`\\b${attr}=["']([^"']+)["']`, "i"))?.[1];
      if (v && !v.startsWith("data:")) found.push({ url: v, alt });
    }
    const srcset = tag.match(/\bsrcset=["']([^"']+)["']/i)?.[1];
    if (srcset) {
      const last = srcset.split(",").map((s) => s.trim().split(/\s+/)[0]).pop();
      if (last) found.push({ url: last, alt });
    }
  }

  // 4. URLs inside inline scripts / JSON blobs (JSON-LD already handled above)
  const decoded = decodeEntities(html.replace(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi, ""));
  for (const m of decoded.matchAll(/https?:\/\/[^\s"'<>()\\]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>\\]*)?/gi)) {
    // Only look inside the enclosing object / tag for a floor-plan caption.
    const start = m.index!;
    const end = start + m[0].length;
    let left = start;
    while (left > 0 && start - left < 150 && !"{}<>[]".includes(decoded[left - 1])) left--;
    let right = end;
    while (right < decoded.length && right - end < 150 && !"{}<>[]".includes(decoded[right])) right++;
    const context = decoded.slice(left, start) + decoded.slice(end, right);
    found.push({ url: m[0], alt: FLOORPLAN.test(context) ? "floor plan" : undefined });
  }

  // Normalize, filter, dedupe (keep the largest variant of each photo).
  const best = new Map<string, FoundImage & { size: number; fp: boolean }>();
  for (const f of found) {
    const url = absolutize(f.url, baseUrl);
    if (!url || JUNK.test(url) || (f.alt && JUNK.test(f.alt))) continue;
    if (!IMAGE_EXT.test(url) && !/\/(image|photo|img)s?\//i.test(url)) continue;
    const key = dedupKey(url);
    const size = sizeHint(url);
    const fp = FLOORPLAN.test(url) || FLOORPLAN.test(f.alt ?? "");
    const prev = best.get(key);
    if (!prev) best.set(key, { url, alt: f.alt, size, fp });
    else {
      if (size > prev.size) Object.assign(prev, { url, size });
      if (!prev.alt && f.alt) prev.alt = f.alt;
      prev.fp ||= fp;
    }
  }

  const photos: FoundImage[] = [];
  const floorPlans: FoundImage[] = [];
  for (const v of best.values()) {
    (v.fp ? floorPlans : photos).push({ url: v.url, alt: v.alt });
  }
  return { photos: photos.slice(0, 40), floorPlans: floorPlans.slice(0, 4) };
}

/** Heuristic: does the user input look like a URL rather than a street address? */
export function looksLikeUrl(input: string): boolean {
  const s = input.trim();
  return /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+\/\S*/.test(s);
}

/** Redfin's autocomplete endpoint prefixes its JSON with `{}&&`. */
export function parseRedfinAutocomplete(body: string): string | null {
  try {
    const json = JSON.parse(body.replace(/^\{\}&&/, ""));
    const exact = json?.payload?.exactMatch?.url;
    if (typeof exact === "string") return exact;
    for (const section of json?.payload?.sections ?? []) {
      for (const row of section?.rows ?? []) {
        if (typeof row?.url === "string" && /\/home\//.test(row.url)) return row.url;
      }
    }
  } catch {
    /* fallthrough */
  }
  return null;
}
