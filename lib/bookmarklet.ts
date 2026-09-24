/**
 * "Send to House Viewer" bookmarklet.
 *
 * Portals bot-block server fetches (Redfin serves an AWS WAF JavaScript
 * challenge; Zillow a 403), but the user's own browser has already passed
 * those checks. The bookmarklet runs on the listing page, collects every image
 * URL in the rendered DOM (including the inline JSON the gallery is built
 * from), and navigates to House Viewer with the list in the URL hash. The hash
 * never reaches a server, and a top-level GET keeps Vercel's login cookie.
 * House Viewer then filters the list with the same rules as the server parser
 * and downloads the images through /api/proxy-image.
 */
import { normalizeFoundImages, type FoundImage } from "./listing-parse";
import type { ImportResult } from "./types";

export const BOOKMARKLET_HASH = "#import=";

/** Upper bound on raw candidates carried in the URL (~20 KB), before dedupe. */
const MAX_CANDIDATES = 200;

export interface BookmarkletPayload {
  v: 1;
  src: string;
  title?: string;
  /** [url, alt] pairs; alt is "floor plan" when the surrounding markup says so. */
  imgs: [string, string][];
}

/** Plain ES2020, self-contained: it runs on the listing site, not in this app. */
function source(origin: string): string {
  return String.raw`(()=>{
const H=document.documentElement.outerHTML.replace(/\\u002F/gi,"/").replace(/\\\//g,"/").replace(/&amp;/g,"&");
const S=new Map();
const add=(u,a)=>{if(!u||u.startsWith("data:"))return;try{u=new URL(u,location.href).href}catch(e){return}
if(!/^https?:/.test(u))return;const k=u.split("?")[0];const p=S.get(k);if(!p)S.set(k,[u,a||""]);else if(a&&!p[1])p[1]=a;};
document.querySelectorAll("img").forEach(i=>add(i.currentSrc||i.src,i.alt));
const FP=/floor[\s_-]?plan/i,B="{}<>[]";
for(const m of H.matchAll(/https?:\/\/[^\s"'<>()\\]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>\\]*)?/gi)){
let l=m.index,r=l+m[0].length;const s=l,e=r;
while(l>0&&s-l<150&&!B.includes(H[l-1]))l--;while(r<H.length&&r-e<150&&!B.includes(H[r]))r++;
add(m[0],FP.test(H.slice(l,s)+H.slice(e,r))?"floor plan":"");}
const L=[...S.values()].slice(0,${MAX_CANDIDATES});
if(!L.length){alert("House Viewer: no photos found on this page. Open the photo gallery, then try again.");return}
location.href=${JSON.stringify(origin)}+"/${BOOKMARKLET_HASH}"+encodeURIComponent(JSON.stringify({v:1,src:location.href,title:document.title,imgs:L}));
})()`;
}

/** The `javascript:` URL to save as a bookmark. */
export function buildBookmarklet(origin: string): string {
  return `javascript:${encodeURIComponent(source(origin).replace(/\n/g, ""))}`;
}

/** Parse the hash House Viewer was opened with; null if it isn't a bookmarklet import. */
export function parseBookmarkletHash(hash: string): BookmarkletPayload | null {
  if (!hash.startsWith(BOOKMARKLET_HASH)) return null;
  try {
    const p = JSON.parse(decodeURIComponent(hash.slice(BOOKMARKLET_HASH.length))) as BookmarkletPayload;
    if (p?.v !== 1 || typeof p.src !== "string" || !Array.isArray(p.imgs)) return null;
    p.imgs = p.imgs.filter((i) => Array.isArray(i) && typeof i[0] === "string").slice(0, MAX_CANDIDATES);
    return p;
  } catch {
    return null;
  }
}

/** Turn the bookmarklet's raw candidates into the same shape a server import returns. */
export function bookmarkletImportResult(p: BookmarkletPayload): ImportResult {
  const found: FoundImage[] = p.imgs.map(([url, alt]) => ({ url, alt: alt || undefined }));
  const { photos, floorPlans } = normalizeFoundImages(found, p.src);
  const host = (() => {
    try {
      return new URL(p.src).hostname;
    } catch {
      return "the listing page";
    }
  })();
  const ok = photos.length + floorPlans.length > 0;
  return {
    ok,
    steps: [`Bookmarklet sent ${p.imgs.length} image URL(s) from ${host}`, `Kept ${photos.length} photo(s) and ${floorPlans.length} likely floor plan(s)`],
    resolvedUrl: p.src,
    photos,
    floorPlans,
    error: ok ? undefined : "The bookmarklet found no listing photos on that page. Open the photo gallery first, then tap it again.",
  };
}
