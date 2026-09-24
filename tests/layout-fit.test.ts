import { describe, expect, it } from "vitest";
import { applyPose, headingToYaw, unproject } from "@/lib/geometry";
import { calibrateFromFloor, fitToRoomBox, wallProfile, type RoomBox } from "@/lib/layout-fit";

const W = 200, H = 150, HFOV = 75;
const BOX: RoomBox = { x0: -2.5, z0: -2, x1: 2.5, z1: 2 };
// A sofa against the bottom wall: something in front of a wall, as in real rooms.
const SOFA = { x0: -1.5, x1: 0.5, z0: 1.1, z1: 2, top: 0.85 };

/**
 * Ray-cast a level camera 1.5 m above the floor of BOX and encode the result
 * the way depth models do: affine inverse depth, 0..255 (here with a made-up
 * near/far that the calibration has to recover).
 */
function render(cam: { x: number; z: number; heading: number }, enc = { near: 0.7, far: 9 }, island = false): Uint8Array {
  const f = W / 2 / Math.tan((HFOV * Math.PI) / 360);
  const yaw = headingToYaw(cam.heading);
  const out = new Uint8Array(W * H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const cx = (px + 0.5 - W / 2) / f, cy = -(py + 0.5 - H / 2) / f;
      const [dx, dz] = applyPose({ yaw, tx: 0, tz: 0, scale: 1 }, cx, -1);
      let t = Infinity; // distance along the camera's view axis (camera-space z = −t)
      const hit = (tt: number) => tt > 0 && tt < t && (t = tt);
      if (cy < 0) hit(-1.5 / cy); // floor
      if (cy > 0) hit(1.1 / cy); // ceiling at 2.6 m
      for (const [x, d] of [[BOX.x0, dx], [BOX.x1, dx]] as const) if (d) hit((x - cam.x) / d);
      for (const [z, d] of [[BOX.z0, dz], [BOX.z1, dz]] as const) if (d) hit((z - cam.z) / d);
      // Sofa front face (z = z0) and top.
      if (dz > 0) {
        const tt = (SOFA.z0 - cam.z) / dz, x = cam.x + dx * tt, y = 1.5 + cy * tt;
        if (x > SOFA.x0 && x < SOFA.x1 && y < SOFA.top) hit(tt);
      }
      // Kitchen island: a level top 0.9 m above the floor, filling the bottom of the frame.
      if (island && cy < 0) {
        const tt = -0.6 / cy, x = cam.x + dx * tt, z = cam.z + dz * tt;
        if (Math.abs(x) < 0.8 && Math.abs(z) < 0.5) hit(tt);
      }
      const inv = (1 / t - 1 / enc.far) / (1 / enc.near - 1 / enc.far);
      out[py * W + px] = Math.round(255 * Math.min(1, Math.max(0, inv)));
    }
  }
  return out;
}

const SHOTS = [
  { x: 2.0, z: 1.5, heading: 315 }, // bottom-right corner looking up-left
  { x: -2.1, z: -1.6, heading: 135 }, // top-left corner looking down-right
  { x: 0, z: -1.7, heading: 180 }, // from the top wall looking down
];

describe("depth calibration from the floor", () => {
  it("recovers metric near/far from a level camera", () => {
    for (const s of SHOTS) {
      const c = calibrateFromFloor(render(s), W, H, HFOV)!;
      expect(c).not.toBeNull();
      expect(c.near).toBeGreaterThan(0.7 * 0.93);
      expect(c.near).toBeLessThan(0.7 * 1.07);
      expect(c.far).toBeGreaterThan(9 * 0.85);
      expect(c.far).toBeLessThan(9 * 1.15);
    }
  });

  it("isn't fooled by a countertop filling the bottom of the frame", () => {
    const c = calibrateFromFloor(render({ x: 0, z: 1.6, heading: 0 }, undefined, true), W, H, HFOV);
    // Either it finds the real floor around the island, or it declines; never the 2.5× countertop scale.
    if (c) expect(c.near).toBeLessThan(0.7 * 1.1);
  });

  it("gives up when there is no floor in view", () => {
    const flat = new Uint8Array(W * H).fill(128);
    expect(calibrateFromFloor(flat, W, H, HFOV)).toBeNull();
  });
});

describe("fit to the plan's room outline", () => {
  it("corrects a Gemini-style guess (off by ~25° and ~0.7 m)", () => {
    for (const s of SHOTS) {
      const depth = render(s);
      const c = calibrateFromFloor(depth, W, H, HFOV)!;
      const { positions, cols, rows } = unproject(depth, W, H, { hfovDeg: HFOV, near: c.near, far: c.far, stride: 2 });
      const initial = { yaw: headingToYaw(s.heading + 25), tx: s.x - 0.5, tz: s.z + 0.5, scale: 1 };
      const fit = fitToRoomBox(wallProfile(positions, cols, rows), BOX, initial);
      expect(fit.accepted).toBe(true);
      expect(fit.fit).toBeGreaterThan(0.6);
      const yawErr = Math.abs(((fit.pose.yaw - headingToYaw(s.heading) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      expect(yawErr).toBeLessThan((5 * Math.PI) / 180);
      expect(Math.hypot(fit.pose.tx - s.x, fit.pose.tz - s.z)).toBeLessThan(0.25);
    }
  });

  it("also fits a depth scale when depth isn't calibrated", () => {
    const s = SHOTS[0];
    // Decode with the wrong range: everything comes out ~25% too close.
    const { positions, cols, rows } = unproject(render(s), W, H, { hfovDeg: HFOV, near: 0.53, far: 6.7, stride: 2 });
    const initial = { yaw: headingToYaw(s.heading + 15), tx: s.x - 0.3, tz: s.z + 0.3, scale: 1 };
    const fit = fitToRoomBox(wallProfile(positions, cols, rows), BOX, initial, { freeScale: true });
    expect(fit.accepted).toBe(true);
    expect(fit.pose.scale).toBeGreaterThan(1.15);
    expect(Math.hypot(fit.pose.tx - s.x, fit.pose.tz - s.z)).toBeLessThan(0.35);
  });

  it("keeps the initial pose when nothing fits", () => {
    const initial = { yaw: 0, tx: 0, tz: 0, scale: 1 };
    const junk: [number, number][] = Array.from({ length: 60 }, (_, i) => [Math.sin(i) * 0.3, -0.5 - (i % 7) * 0.05]);
    const fit = fitToRoomBox(junk, BOX, initial);
    expect(fit.accepted).toBe(false);
    expect(fit.pose).toEqual(initial);
  });
});
