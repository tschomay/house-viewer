import { describe, expect, it } from "vitest";
import { MAX_PHOTOS_PER_SORT, normalizeSort, sortBatches, sortPrompt } from "@/lib/sorting";
import type { RoomGraph } from "@/lib/types";

const graph: RoomGraph = {
  rooms: [
    { id: "bedroom_1", label: "Bedroom 1", type: "bedroom", neighbors: ["hall"], centroid: { x: 0.2, y: 0.2 } },
    { id: "bedroom_2", label: "Bedroom 2", type: "bedroom", neighbors: ["hall"], centroid: { x: 0.8, y: 0.2 } },
    { id: "hall", label: "Hall", type: "hallway", neighbors: ["bedroom_1", "bedroom_2"], centroid: { x: 0.5, y: 0.5 } },
  ],
};

describe("one-call sort", () => {
  it("maps numbered photos to ids, keeps the look, and never moves fixed photos", () => {
    const photos = [{ id: "a" }, { id: "b", fixedRoomId: "bedroom_1" }, { id: "c" }, { id: "d", fixedRoomId: "hall" }];
    const res = normalizeSort(
      {
        photos: [
          { photo: 1, appearance: "sage walls, carpet, vaulted", roomId: "bedroom_2", isExterior: false, confidence: 0.9, headingDeg: 90, reasoning: "same sage walls as 3" },
          { photo: 2, appearance: "white walls", roomId: "bedroom_2", isExterior: false, confidence: 0.8, headingDeg: null, reasoning: "" },
          { photo: 3, appearance: "", roomId: "garage", isExterior: false, confidence: 0.9, headingDeg: null, reasoning: "" },
          { photo: 4, appearance: "", roomId: "bedroom_1", isExterior: false, confidence: 0.3, headingDeg: null, reasoning: "" },
          { photo: 1, appearance: "dup", roomId: "hall", isExterior: false, confidence: 1, headingDeg: 0, reasoning: "" },
          { photo: 9, roomId: "hall" },
        ],
        notes: "two bedrooms look alike",
      },
      photos,
      graph,
    );
    expect(res.matches.map((m) => m.photoId)).toEqual(["a", "c"]);
    expect(res.matches[0]).toMatchObject({ roomId: "bedroom_2", appearance: "sage walls, carpet, vaulted", status: "matched", headingDeg: null });
    // Unknown room id → unmatched, not invented.
    expect(res.matches[1]).toMatchObject({ roomId: null, status: "unmatched" });
    // Confident disagreement with a fixed photo is reported; an unsure one isn't.
    expect(res.disagreements).toEqual({ b: "bedroom_2" });
    expect(res.notes).toBe("two bedrooms look alike");
  });

  it("marks fixed photos and captions in the prompt, and carries earlier batches as text", () => {
    const p = sortPrompt(graph, [{ id: "a", label: "Primary suite" }, { id: "b", fixedRoomId: "hall" }, { id: "c", fixedExterior: true }], ["- Hall: grey walls"]);
    expect(p).toContain('PHOTO 1 (caption: "Primary suite")');
    expect(p).toContain("PHOTO 2 — FIXED by the user: hall");
    expect(p).toContain("PHOTO 3 — FIXED by the user: exterior");
    expect(p).toContain("- Hall: grey walls");
  });

  it("batches big listings evenly, in order", () => {
    const ids = Array.from({ length: MAX_PHOTOS_PER_SORT + 4 }, (_, i) => i);
    const b = sortBatches(ids);
    expect(b.length).toBe(2);
    expect(b.flat()).toEqual(ids);
    expect(Math.abs(b[0].length - b[1].length)).toBeLessThanOrEqual(1);
    expect(sortBatches([1, 2, 3])).toEqual([[1, 2, 3]]);
  });
});
