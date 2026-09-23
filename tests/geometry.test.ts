import { describe, expect, it } from "vitest";
import { applyPose, gridIndices, headingToYaw, inverseToMetric, unproject } from "@/lib/geometry";
import { fitSimilarity2D, mergeClouds } from "@/lib/merge";

describe("depth unprojection", () => {
  it("maps inverse depth endpoints to near/far", () => {
    expect(inverseToMetric(1, 1, 8)).toBeCloseTo(1);
    expect(inverseToMetric(0, 1, 8)).toBeCloseTo(8);
  });

  it("puts the image centre on the −Z axis", () => {
    const depth = new Uint8Array(9 * 9).fill(0);
    const { positions, cols } = unproject(depth, 9, 9, { hfovDeg: 90, near: 1, far: 4 });
    const centre = 4 * cols + 4;
    expect(positions[centre * 3]).toBeCloseTo(0);
    expect(positions[centre * 3 + 1]).toBeCloseTo(0);
    expect(positions[centre * 3 + 2]).toBeCloseTo(-4);
    // 90° hfov: the right edge is at x ≈ z
    expect(positions[(4 * cols + 8) * 3]).toBeCloseTo(4 * (4 / 4.5), 1);
  });

  it("drops triangles across depth discontinuities", () => {
    const depth = new Uint8Array(4 * 4);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) depth[r * 4 + c] = c < 2 ? 255 : 0;
    const { positions, cols, rows } = unproject(depth, 4, 4, { hfovDeg: 60, near: 1, far: 5 });
    const all = (cols - 1) * (rows - 1) * 2;
    expect(gridIndices(positions, cols, rows).length / 3).toBe(all - 6);
  });
});

describe("floor plan heading", () => {
  it("heading 90° (plan right) faces +X", () => {
    // Camera forward (0,−1) in XZ, rotated by the yaw for heading 90°.
    const [x, z] = applyPose({ yaw: headingToYaw(90), tx: 0, tz: 0, scale: 1 }, 0, -1);
    expect(x).toBeCloseTo(1);
    expect(z).toBeCloseTo(0);
  });
});

describe("2D similarity fit", () => {
  it("recovers a known transform", () => {
    const truth = { yaw: 0.7, tx: 1.5, tz: -2, scale: 1.3 };
    const src: [number, number][] = [[0, 0], [1, 0], [0, 2], [3, 1], [-1, 4]];
    const dst = src.map(([x, z]) => applyPose(truth, x, z));
    const fit = fitSimilarity2D(src, dst);
    expect(fit.yaw).toBeCloseTo(truth.yaw);
    expect(fit.scale).toBeCloseTo(truth.scale);
    expect(fit.tx).toBeCloseTo(truth.tx);
    expect(fit.tz).toBeCloseTo(truth.tz);
  });
});

/** Points on the walls of a 5×4 m box room, seen from a camera at `cam`. */
function roomCloud(cam: { x: number; z: number; yaw: number }): Float32Array {
  const pts: number[] = [];
  const walls: [number, number][] = [];
  for (let t = 0; t <= 1; t += 0.01) {
    walls.push([-2.5 + 5 * t, -2], [-2.5 + 5 * t, 2], [-2.5, -2 + 4 * t], [2.5, -2 + 4 * t]);
  }
  // Add an asymmetric feature (a kitchen island) so yaw is observable.
  for (let t = 0; t <= 1; t += 0.05) walls.push([0.5 + t, -0.5], [0.5 + t, 0.3]);
  // world → camera: inverse of the camera pose.
  const inv = { yaw: -cam.yaw, tx: 0, tz: 0, scale: 1 };
  for (const [wx, wz] of walls) {
    const [x, z] = applyPose(inv, wx - cam.x, wz - cam.z);
    for (const y of [-1, 0, 0.5, 1]) pts.push(x, y, z);
  }
  return Float32Array.from(pts);
}

describe("mergeClouds", () => {
  it("refines a perturbed initial pose onto the anchor cloud", () => {
    const a = { x: -1, z: 1, yaw: 0.3 };
    const b = { x: 1.2, z: -0.5, yaw: 2.1 };
    const result = mergeClouds([
      { id: "a", positions: roomCloud(a), initial: { yaw: a.yaw, tx: a.x, tz: a.z, scale: 1 } },
      // Gemini's guess is off by ~15° and ~40 cm.
      { id: "b", positions: roomCloud(b), initial: { yaw: b.yaw + 0.25, tx: b.x + 0.3, tz: b.z - 0.25, scale: 1 } },
    ]);
    expect(result.merged).toBe(true);
    const pb = result.clouds[1].pose;
    expect(pb.yaw).toBeCloseTo(b.yaw, 1);
    expect(pb.tx).toBeCloseTo(b.x, 1);
    expect(pb.tz).toBeCloseTo(b.z, 1);
  });

  it("falls back when the initial guess is hopeless", () => {
    const a = { x: 0, z: 0, yaw: 0 };
    const result = mergeClouds([
      { id: "a", positions: roomCloud(a), initial: { yaw: 0, tx: 0, tz: 0, scale: 1 } },
      { id: "b", positions: roomCloud(a), initial: { yaw: 0, tx: 30, tz: 30, scale: 1 } },
    ]);
    expect(result.merged).toBe(false);
    expect(result.clouds[1].registered).toBe(false);
  });
});

describe("mergeClouds regressions", () => {
  it("keeps scale fixed (partial overlap used to shrink clouds to cheat the inlier score)", () => {
    const a = { x: -1, z: 1, yaw: 0.3 };
    const b = { x: 1.2, z: -0.5, yaw: 2.1 };
    const result = mergeClouds([
      { id: "a", positions: roomCloud(a), initial: { yaw: a.yaw, tx: a.x, tz: a.z, scale: 1 } },
      { id: "b", positions: roomCloud(b), initial: { yaw: b.yaw + 0.1, tx: b.x, tz: b.z, scale: 1 } },
    ]);
    expect(result.clouds[1].pose.scale).toBe(1);
  });

  it("places anchored photos from the plan even without overlap, and never moves them far", () => {
    const a = { x: 0, z: 0, yaw: 0 };
    const result = mergeClouds([
      { id: "a", positions: roomCloud(a), initial: { yaw: 0, tx: 0, tz: 0, scale: 1 }, anchored: true },
      { id: "b", positions: roomCloud(a), initial: { yaw: 0, tx: 30, tz: 30, scale: 1 }, anchored: true },
    ]);
    expect(result.merged).toBe(true);
    expect(result.clouds[1].registered).toBe(true);
    expect(Math.hypot(result.clouds[1].pose.tx - 30, result.clouds[1].pose.tz - 30)).toBeLessThanOrEqual(0.8);
  });
});
