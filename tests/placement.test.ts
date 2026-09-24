import { describe, expect, it } from "vitest";
import { applyPlacement, normalizePlacements, placementBatches, placementPrompt } from "@/lib/placement";
import type { PhotoMatch, RoomGraph } from "@/lib/types";

const graph: RoomGraph = {
  rooms: [
    { id: "living", label: "Living Room", type: "living", neighbors: ["kitchen"], centroid: { x: 0.3, y: 0.3 }, bbox: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 }, sizeM: { width: 6, depth: 5 } },
    { id: "kitchen", label: "Kitchen", type: "kitchen", neighbors: ["living"], centroid: { x: 0.7, y: 0.3 }, bbox: { x0: 0.5, y0: 0.1, x1: 0.9, y1: 0.5 } },
  ],
};
const living = graph.rooms[0];

describe("placement pass", () => {
  it("maps numbered photos back to ids, clamps positions near the room and wraps headings", () => {
    const out = normalizePlacements(
      {
        placements: [
          { photo: 2, belongsHere: true, cameraPosition: { x: 0.95, y: 0.3 }, headingDeg: -90, confidence: 0.8, note: "window left" },
          { photo: 1, belongsHere: false, betterRoomId: "kitchen", cameraPosition: null, headingDeg: null, confidence: 0.4, note: "" },
          { photo: 7, belongsHere: true, cameraPosition: { x: 0.2, y: 0.2 }, headingDeg: 0, confidence: 1, note: "" },
          { photo: 2, belongsHere: true, cameraPosition: { x: 0.2, y: 0.2 }, headingDeg: 0, confidence: 1, note: "duplicate" },
        ],
      },
      ["a", "b"],
      living,
      graph,
    );
    expect(out.map((p) => p.photoId)).toEqual(["a", "b"]);
    expect(out[0]).toMatchObject({ belongsHere: false, suggestedRoomId: "kitchen", headingDeg: null });
    expect(out[1].headingDeg).toBe(270);
    expect(out[1].note).toBe("window left");
    // 0.95 is far outside the living room (x ≤ 0.5): clamped to the doorway margin.
    expect(out[1].cameraPosition!.x).toBeLessThan(0.65);
  });

  it("ignores unknown or same-room suggestions", () => {
    const out = normalizePlacements(
      { placements: [{ photo: 1, belongsHere: false, betterRoomId: "garage", headingDeg: 10, cameraPosition: null, confidence: 0.3, note: "" }] },
      ["a"],
      living,
      graph,
    );
    expect(out[0].suggestedRoomId).toBeNull();
  });

  it("keeps the room and manual flag, and only takes a pose when the photo belongs here", () => {
    const m: PhotoMatch = { photoId: "a", roomId: "living", confidence: 1, headingDeg: null, cameraPosition: null, reasoning: "Assigned by you.", status: "matched", manual: true };
    const placed = applyPlacement(m, { photoId: "a", belongsHere: true, suggestedRoomId: null, headingDeg: 45, cameraPosition: { x: 0.2, y: 0.4 }, confidence: 0.7, note: "n" });
    expect(placed).toMatchObject({ roomId: "living", manual: true, placed: true, headingDeg: 45, cameraPosition: { x: 0.2, y: 0.4 } });
    const doubted = applyPlacement(m, { photoId: "a", belongsHere: false, suggestedRoomId: "kitchen", headingDeg: 45, cameraPosition: null, confidence: 0.2, note: "" });
    expect(doubted).toMatchObject({ placed: false, headingDeg: null, suggestedRoomId: "kitchen" });
  });

  it("never moves a camera the user set by hand, and tells Gemini about it", () => {
    const m: PhotoMatch = { photoId: "a", roomId: "living", confidence: 1, headingDeg: 90, cameraPosition: { x: 0.2, y: 0.2 }, reasoning: "", status: "matched", manualPose: true, placed: true };
    const out = applyPlacement(m, { photoId: "a", belongsHere: true, suggestedRoomId: null, headingDeg: 270, cameraPosition: { x: 0.4, y: 0.4 }, confidence: 0.9, note: "n" });
    expect(out).toMatchObject({ headingDeg: 90, cameraPosition: { x: 0.2, y: 0.2 }, manualPose: true, placementNote: "n" });
    expect(placementPrompt(living, graph, 2, [{ photo: 2, x: 0.2, y: 0.25, headingDeg: 90 }])).toContain("PHOTO 2 at (0.20, 0.25) facing 90°");
  });

  it("splits big rooms into even batches", () => {
    expect(placementBatches([1, 2, 3]).map((b) => b.length)).toEqual([3]);
    expect(placementBatches(Array.from({ length: 8 }, (_, i) => i)).map((b) => b.length)).toEqual([4, 4]);
  });

  it("tells Gemini where the room is and what it opens onto", () => {
    const p = placementPrompt(living, graph, 3);
    expect(p).toContain("Living Room");
    expect(p).toContain("x 0.10–0.50");
    expect(p).toContain("Kitchen (right on the plan)");
    expect(p).toContain("kitchen (Kitchen)");
  });
});
