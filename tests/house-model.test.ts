import { describe, expect, it } from "vitest";
import { buildFlightPath, buildHouseModel, clusterFloors, doorway, EYE_H, roomWallInfo, sampleAt, STOREY_M, tourOrder } from "@/lib/house-model";
import { parseWallArtRoom, wallArtPrompt } from "@/lib/wall-art";
import type { PhotoMatch, Room, RoomGraph } from "@/lib/types";

// Plan units: the plan is 20 m wide and 20 m tall (square image), so 1 unit = 20 m both ways.
const M = 20;
const room = (id: string, type: string, x0: number, z0: number, x1: number, z1: number, neighbors: string[], sized = true): Room => ({
  id,
  label: id,
  type,
  neighbors,
  centroid: { x: (x0 + x1) / 2 / M, y: (z0 + z1) / 2 / M },
  bbox: { x0: x0 / M, y0: z0 / M, x1: x1 / M, y1: z1 / M },
  sizeM: sized ? { width: x1 - x0, depth: z1 - z0 } : null,
});

// Ground floor drawn at the bottom of the image, upper floor above it (as on real plans).
const ground: Room[] = [
  room("entry", "entry", 4, 14, 7, 18, ["living", "kitchen", "stairs_down"]),
  room("living", "living", 7, 13, 12, 18, ["entry"]),
  room("kitchen", "kitchen", 1, 13, 4, 18, ["entry", "bath"]),
  room("bath", "bathroom", 1, 11, 4, 13, ["kitchen"]),
  room("stairs_down", "stairs", 4.5, 14.2, 6.5, 15.5, ["entry", "stairs_up"], false),
];
const upper: Room[] = [
  room("hall", "hallway", 4, 3, 7, 7, ["bed1", "bed2", "stairs_up"]),
  room("bed1", "bedroom", 1, 3, 4, 7, ["hall"]),
  room("bed2", "bedroom", 7, 3, 11, 7, ["hall"]),
  room("stairs_up", "stairs", 4.5, 3.2, 6.5, 4.5, ["hall", "stairs_down"], false),
];
const graph: RoomGraph = { rooms: [...ground, ...upper] };
const match = (photoId: string, roomId: string, x: number, z: number, headingDeg: number): PhotoMatch => ({
  photoId,
  roomId,
  confidence: 1,
  headingDeg,
  cameraPosition: { x: x / M, y: z / M },
  reasoning: "",
  status: "matched",
  placed: true,
});
const matches: Record<string, PhotoMatch> = Object.fromEntries(
  [
    match("p1", "living", 11, 17, 315),
    match("p2", "living", 8, 14, 135),
    match("p3", "kitchen", 2, 17, 0),
    match("p4", "bed1", 2, 6, 45),
    match("p5", "entry", 5.5, 17, 0),
  ].map((m) => [m.photoId, m]),
);

describe("house model", () => {
  const model = buildHouseModel(graph, 1, matches);

  it("finds the storeys and stacks the upper one on the ground floor by its stairs", () => {
    expect(clusterFloors(graph.rooms).map((c) => c.sort())).toHaveLength(2);
    const byId = new Map(model.rooms.map((r) => [r.id, r]));
    expect(byId.get("entry")!.elevation).toBe(0);
    expect(byId.get("hall")!.elevation).toBe(STOREY_M);
    // Upper stairs land over the lower stairs (drawn 11 m apart on the image).
    const lo = byId.get("stairs_down")!.box, up = byId.get("stairs_up")!.box;
    expect((up.z0 + up.z1) / 2).toBeCloseTo((lo.z0 + lo.z1) / 2, 5);
    expect(model.stairs).toHaveLength(1);
    // Both stair rooms sit inside bigger rooms, so the run joins those.
    expect(model.stairs[0]).toMatchObject({ lowerRoomId: "entry", upperRoomId: "hall", y0: 0, y1: STOREY_M });
  });

  it("treats stairs drawn inside the foyer as part of it", () => {
    expect(model.rooms.find((r) => r.id === "stairs_down")!.parent).toBe("entry");
    expect(model.walls.some((w) => w.roomId === "stairs_down")).toBe(false);
  });

  it("cuts doors between private rooms and full openings in open plans, on both sides", () => {
    const kb = model.cuts.filter((c) => [c.roomId, c.otherId].sort().join() === "bath,kitchen");
    expect(kb.map((c) => c.side).sort()).toEqual(["bottom", "top"]);
    expect(kb[0].kind).toBe("door");
    expect(kb[0].to - kb[0].from).toBeCloseTo(0.9, 5);
    const open = model.cuts.find((c) => c.roomId === "entry" && c.otherId === "living")!;
    expect(open).toMatchObject({ kind: "open", side: "right" });
    expect(open.to - open.from).toBeGreaterThan(3);
  });

  it("puts the front door on the entry's outside wall, open only from outside", () => {
    expect(model.entryId).toBe("entry");
    expect(model.front).toMatchObject({ nx: 0, nz: 1 });
    const bottom = model.walls.filter((w) => w.roomId === "entry" && w.side === "bottom");
    const inside = bottom.filter((w) => !w.outside), outside = bottom.filter((w) => w.outside);
    expect(inside).toHaveLength(1); // unbroken from inside
    expect(outside.length).toBeGreaterThan(1); // door cut from outside
  });

  it("gives wall pieces texture coordinates left → right as seen from inside", () => {
    const top = model.walls.filter((w) => w.roomId === "bed2" && w.side === "top" && !w.outside);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ u0: 0, u1: 1, v0: 0, v1: 1 });
    expect(top[0].ax).toBeLessThan(top[0].bx);
    const bottom = model.walls.find((w) => w.roomId === "bed2" && w.side === "bottom" && !w.outside && w.u0 === 0)!;
    expect(bottom.ax).toBeGreaterThan(bottom.bx); // facing the bottom wall, left is +x
  });

  it("describes each wall's doorways for the wall-art prompt", () => {
    const walls = roomWallInfo(model, "kitchen")!;
    expect(walls.map((w) => w.side)).toEqual(["top", "right", "bottom", "left"]);
    expect(walls.find((w) => w.side === "top")!.openings).toEqual([expect.objectContaining({ kind: "door", to_room: "bath" })]);
    expect(walls.find((w) => w.side === "left")!.exterior).toBe(true);
  });
});

describe("doorway", () => {
  it("handles boxes that don't quite touch", () => {
    const d = doorway({ x0: 0, x1: 4, z0: 0, z1: 4 }, { x0: 4.3, x1: 8, z0: 1, z1: 5 }, false);
    expect(d).toMatchObject({ sideA: "right", sideB: "left" });
    expect(d.pA[0]).toBeLessThan(4);
    expect(d.pB[0]).toBeGreaterThan(4.3);
    expect(d.pA[1]).toBeCloseTo(d.pB[1]);
  });
});

describe("flight path", () => {
  const model = buildHouseModel(graph, 1, matches);
  const path = buildFlightPath(model);

  it("tours the ground floor first, then climbs the stairs", () => {
    const order = tourOrder(model).map((s) => s.roomId);
    expect(order[0]).toBe("entry");
    const firstUp = order.indexOf("hall");
    expect(firstUp).toBeGreaterThan(0);
    for (const id of ["living", "kitchen", "bath"]) expect(order.indexOf(id)).toBeLessThan(firstUp);
    for (const id of ["bed1", "bed2"]) expect(order.indexOf(id)).toBeGreaterThan(firstUp);
    expect(path.chapters.map((c) => c.roomId)).toEqual(expect.arrayContaining(["entry", "living", "kitchen", "bath", "hall", "bed1", "bed2"]));
  });

  it("stops at every photo, facing exactly the way it was taken", () => {
    for (const r of model.rooms)
      for (const p of r.photos) {
        const at = path.samples.filter((s) => s.photoId === p.photoId);
        expect(at.length, p.photoId).toBeGreaterThan(5);
        expect(Math.cos(at[0].yaw - p.yaw)).toBeCloseTo(1, 3);
        expect(Math.hypot(at[0].x - p.x, at[0].z - p.z)).toBeLessThan(0.5);
      }
  });

  it("never leaves the rooms once inside (no flying through walls)", () => {
    const rooms = model.rooms.filter((r) => !r.parent);
    const inside = (s: { x: number; y: number; z: number }) =>
      rooms.some((r) => Math.abs(s.y - EYE_H - r.elevation) < 3.2 && s.x > r.box.x0 - 0.9 && s.x < r.box.x1 + 0.9 && s.z > r.box.z0 - 0.9 && s.z < r.box.z1 + 0.9);
    const indoor = path.samples.filter((s) => s.roomId);
    expect(indoor.length).toBeGreaterThan(100);
    for (const s of indoor) expect(inside(s), JSON.stringify(s)).toBe(true);
  });

  it("starts in the air and climbs a storey on the stairs", () => {
    expect(path.samples[0].y).toBeGreaterThan(5);
    expect(path.samples[0].roomId).toBeNull();
    const ys = path.samples.filter((s) => s.roomId).map((s) => s.y);
    expect(Math.min(...ys)).toBeCloseTo(EYE_H, 1);
    expect(Math.max(...ys)).toBeCloseTo(EYE_H + STOREY_M, 1);
  });

  it("interpolates between samples", () => {
    const a = sampleAt(path, 10)!, b = sampleAt(path, 10.1)!, mid = sampleAt(path, 10.05)!;
    expect(mid.x).toBeCloseTo((a.x + b.x) / 2, 5);
    expect(sampleAt(path, 1e9)!.t).toBe(1e9);
  });
});

describe("wall-art prompt", () => {
  const model = buildHouseModel(graph, 1, matches);
  it("names each strip's wall, length and doorways, and each photo's viewpoint", () => {
    const walls = roomWallInfo(model, "living")!;
    const text = wallArtPrompt({ label: "Living", type: "living", widthM: 5, depthM: 5, walls, photos: [{ headingDeg: 315, x: 0.8, z: 0.8 }] });
    expect(text).toContain("Strip 1: TOP wall");
    expect(text).toContain("Strip 4: LEFT wall");
    expect(text).toMatch(/wide opening into the entry/);
    expect(text).toContain("facing the TOP/LEFT corner wall");
  });
  it("clamps whatever the client sends", () => {
    const r = parseWallArtRoom({ label: "x".repeat(500), type: "bedroom", widthM: 1e9, walls: [{ side: "nope" }, { side: "top", lengthM: -3, openings: [{ from: -1, to: 2, kind: "evil" }] }], photos: Array(9).fill({}) })!;
    expect(r.label).toHaveLength(60);
    expect(r.widthM).toBe(40);
    expect(r.walls).toEqual([{ side: "top", lengthM: 0.3, exterior: false, openings: [{ from: 0, to: 1, kind: "door", to_room: "next room" }] }]);
    expect(r.photos).toHaveLength(4);
    expect(parseWallArtRoom(null)).toBeNull();
  });
});
