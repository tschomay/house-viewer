import { describe, expect, it } from "vitest";
import { dedupKey, extractListingImages, looksLikeUrl, parseRedfinAutocomplete } from "@/lib/listing-parse";
import { groupByRoom, normalizePhotoMatch, normalizeRoomGraph } from "@/lib/room-graph";

const PAGE = `
<html><head>
<meta property="og:image" content="https://cdn.example.com/photos/abc_1024.jpg">
<script type="application/ld+json">{"@type":"SingleFamilyResidence","image":["https://cdn.example.com/photos/abc_1536.jpg","https://cdn.example.com/photos/def_1536.jpg"],
 "floorPlan":{"@type":"FloorPlan","image":"https://cdn.example.com/plans/main.png"}}</script>
<script>window.__DATA__={"photos":[{"url":"https:\\/\\/cdn.example.com\\/photos\\/ghi_768.webp","caption":"Kitchen"}]}</script>
</head><body>
<img src="/static/logo.png" alt="Brokerage logo">
<img src="https://cdn.example.com/photos/jkl.jpg" alt="Primary bedroom">
<img data-src="https://cdn.example.com/media/floor-plan-level1.jpg" alt="Floor plan">
<img src="https://maps.googleapis.com/maps/api/staticmap?center=x.png">
</body></html>`;

describe("extractListingImages", () => {
  const { photos, floorPlans } = extractListingImages(PAGE, "https://listing.example.com/home/1");

  it("collects photos from JSON-LD, meta, img and inline JSON, deduped by size variant", () => {
    const urls = photos.map((p) => p.url).sort();
    expect(urls).toEqual([
      "https://cdn.example.com/photos/abc_1536.jpg",
      "https://cdn.example.com/photos/def_1536.jpg",
      "https://cdn.example.com/photos/ghi_768.webp",
      "https://cdn.example.com/photos/jkl.jpg",
    ]);
  });

  it("separates floor plans and drops logos/maps", () => {
    expect(floorPlans.map((f) => f.url).sort()).toEqual([
      "https://cdn.example.com/media/floor-plan-level1.jpg",
      "https://cdn.example.com/plans/main.png",
    ]);
  });

  it("dedup key ignores size suffixes", () => {
    expect(dedupKey("https://x/p/a_-cc_ft_384.jpg")).toBe(dedupKey("https://x/p/a_-cc_ft_1536.jpg"));
  });
});

describe("input helpers", () => {
  it("distinguishes URLs from addresses", () => {
    expect(looksLikeUrl("https://www.zillow.com/homedetails/1")).toBe(true);
    expect(looksLikeUrl("redfin.com/CA/x/home/123")).toBe(true);
    expect(looksLikeUrl("123 Main St, Springfield, IL")).toBe(false);
  });

  it("parses Redfin autocomplete", () => {
    const body = '{}&&{"payload":{"sections":[{"rows":[{"url":"/IL/Springfield/123-Main-St-62701/home/42"}]}]}}';
    expect(parseRedfinAutocomplete(body)).toBe("/IL/Springfield/123-Main-St-62701/home/42");
    expect(parseRedfinAutocomplete("garbage")).toBeNull();
  });
});

describe("room graph normalization", () => {
  const graph = normalizeRoomGraph({
    rooms: [
      { id: "Kitchen", label: "Kitchen", type: "kitchen", neighbors: ["living", "ghost"], centroid: { x: 0.2, y: 1.4 } },
      { id: "living", label: "Living Room", type: "living", neighbors: [], centroid: { x: 0.6, y: 0.5 }, sizeM: { width: 5, depth: 4 } },
      { id: "living", label: "Den", type: "living", neighbors: ["kitchen"], centroid: { x: 0.8, y: 0.2 } },
    ],
  });

  it("dedupes ids, clamps centroids, symmetrizes adjacency, drops unknown neighbors", () => {
    expect(graph.rooms.map((r) => r.id)).toEqual(["kitchen", "living", "living_2"]);
    expect(graph.rooms[0].centroid.y).toBe(1);
    expect(graph.rooms[0].neighbors.sort()).toEqual(["living", "living_2"]);
    expect(graph.rooms[1].neighbors).toEqual(["kitchen"]);
    expect(graph.rooms[1].sizeM).toEqual({ width: 5, depth: 4 });
  });

  it("classifies matches", () => {
    expect(normalizePhotoMatch("p", { roomId: "kitchen", confidence: 0.9, headingDeg: -90 }, graph)).toMatchObject({
      status: "matched",
      headingDeg: 270,
    });
    expect(normalizePhotoMatch("p", { roomId: "kitchen", confidence: 0.3 }, graph).status).toBe("low-confidence");
    expect(normalizePhotoMatch("p", { roomId: "nope", confidence: 0.9 }, graph).status).toBe("unmatched");
    expect(normalizePhotoMatch("p", { roomId: null, isExterior: true }, graph).status).toBe("exterior");
    const groups = groupByRoom([
      normalizePhotoMatch("a", { roomId: "kitchen", confidence: 0.9 }, graph),
      normalizePhotoMatch("b", { roomId: null }, graph),
    ]);
    expect(groups).toEqual({ kitchen: ["a"], _unmatched: ["b"] });
  });
});
