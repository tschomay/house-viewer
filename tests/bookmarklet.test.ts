import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { bookmarkletImportResult, buildBookmarklet, parseBookmarkletHash } from "@/lib/bookmarklet";

const PAGE_URL = "https://www.redfin.com/OH/Avon/36316-S-Park-Dr-44011/home/77239821";
const HTML = `<html><body>
<img src="https://ssl.cdn-redfin.com/photo/92/islphoto/370/genIslnoResize.5041370_0.jpg" alt="36316 S Park Dr">
<img src="/images/logos/redfin-logo.png" alt="Redfin">
<script>window.__data={"photos":[{"url":"https:\\u002F\\u002Fssl.cdn-redfin.com\\u002Fphoto\\u002F92\\u002Fbigphoto\\u002F370\\u002F5041370_1_0.jpg"},
{"caption":"Floor Plan","url":"https:\\/\\/ssl.cdn-redfin.com\\/photo\\/92\\/bigphoto\\/370\\/5041370_24_0.jpg"}]}</script>
</body></html>`;

/** Run the bookmarklet against a stub page and return where it navigated. */
function run(html: string, imgs: { currentSrc: string; alt: string }[]): string | null {
  const js = decodeURIComponent(buildBookmarklet("https://house-viewer.example").slice("javascript:".length));
  const location = { href: PAGE_URL };
  let alerted = false;
  runInNewContext(js, {
    document: { documentElement: { outerHTML: html }, title: "36316 S Park Dr", querySelectorAll: () => imgs },
    location,
    alert: () => (alerted = true),
    URL,
  });
  return alerted ? null : location.href;
}

describe("bookmarklet", () => {
  it("collects page images and hands them to House Viewer in the hash", () => {
    const href = run(HTML, [{ currentSrc: "https://ssl.cdn-redfin.com/photo/92/islphoto/370/genIslnoResize.5041370_0.jpg", alt: "36316 S Park Dr" }]);
    expect(href).toMatch(/^https:\/\/house-viewer\.example\/#import=/);
    const payload = parseBookmarkletHash(new URL(href!).hash)!;
    expect(payload.src).toBe(PAGE_URL);

    const result = bookmarkletImportResult(payload);
    expect(result.ok).toBe(true);
    expect(result.photos.map((p) => p.url)).toEqual([
      "https://ssl.cdn-redfin.com/photo/92/islphoto/370/genIslnoResize.5041370_0.jpg",
      "https://ssl.cdn-redfin.com/photo/92/bigphoto/370/5041370_1_0.jpg",
    ]);
    expect(result.floorPlans.map((p) => p.url)).toEqual(["https://ssl.cdn-redfin.com/photo/92/bigphoto/370/5041370_24_0.jpg"]);
  });

  it("alerts instead of navigating when the page has no images", () => {
    expect(run("<html></html>", [])).toBeNull();
  });

  it("ignores hashes that aren't bookmarklet imports", () => {
    expect(parseBookmarkletHash("")).toBeNull();
    expect(parseBookmarkletHash("#import=not-json")).toBeNull();
    expect(parseBookmarkletHash("#other")).toBeNull();
  });
});
