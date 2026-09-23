import "server-only";
import type { ImportResult } from "./types";
import { extractListingImages, looksLikeUrl, parseRedfinAutocomplete } from "./listing-parse";
import { FetchBlockedError, readLimited, safeFetch } from "./safe-fetch";

/**
 * Best-effort listing import. Big portals (Zillow, Redfin, Realtor.com)
 * aggressively bot-block server-side fetches, so failure is an expected
 * outcome — every path returns a result the UI can explain, never throws.
 */
export async function importListing(input: string): Promise<ImportResult> {
  const steps: string[] = [];
  const result: ImportResult = { ok: false, steps, photos: [], floorPlans: [] };

  let url = input.trim();
  if (!looksLikeUrl(url)) {
    steps.push("Input looks like an address — trying Redfin address lookup");
    const resolved = await resolveAddress(url, steps);
    if (!resolved) {
      result.error =
        "Couldn't turn that address into a listing page. Paste the listing URL instead, or add photos manually.";
      return result;
    }
    url = resolved;
  } else if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  result.resolvedUrl = url;

  let html: string;
  try {
    const res = await safeFetch(url);
    steps.push(`Fetched ${new URL(url).hostname} → HTTP ${res.status}`);
    if (res.status === 403 || res.status === 429 || res.status === 451) {
      result.error = `The site blocked the automated request (HTTP ${res.status}). This is common for Zillow/Redfin.`;
      return result;
    }
    if (!res.ok) {
      result.error = `The listing page returned HTTP ${res.status}.`;
      return result;
    }
    html = new TextDecoder().decode(await readLimited(res, 8 * 1024 * 1024));
  } catch (e) {
    result.error = e instanceof FetchBlockedError ? e.message : `Fetch failed: ${(e as Error).message}`;
    steps.push(result.error);
    return result;
  }

  if (/captcha|px-captcha|are you a human|access to this page has been denied|perimeterx/i.test(html) && html.length < 60_000) {
    steps.push("Page looks like a bot-check / CAPTCHA wall");
    result.error = "The site served a CAPTCHA instead of the listing.";
    return result;
  }

  const { photos, floorPlans } = extractListingImages(html, url);
  steps.push(`Found ${photos.length} photo(s) and ${floorPlans.length} likely floor plan(s)`);
  result.photos = photos;
  result.floorPlans = floorPlans;
  result.ok = photos.length + floorPlans.length > 0;
  if (!result.ok) result.error = "The page loaded but no listing photos were found in it.";
  return result;
}

async function resolveAddress(address: string, steps: string[]): Promise<string | null> {
  const endpoint = `https://www.redfin.com/stingray/do/location-autocomplete?v=2&location=${encodeURIComponent(address)}`;
  try {
    const res = await safeFetch(endpoint, { headers: { accept: "application/json,text/plain,*/*" } });
    steps.push(`Redfin lookup → HTTP ${res.status}`);
    if (!res.ok) return null;
    const path = parseRedfinAutocomplete(new TextDecoder().decode(await readLimited(res, 1024 * 1024)));
    if (!path) {
      steps.push("Redfin lookup found no matching home");
      return null;
    }
    const full = new URL(path, "https://www.redfin.com").toString();
    steps.push(`Resolved address to ${full}`);
    return full;
  } catch (e) {
    steps.push(`Redfin lookup failed: ${(e as Error).message}`);
    return null;
  }
}
