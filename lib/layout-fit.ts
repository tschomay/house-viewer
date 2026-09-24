/**
 * Plan-constrained placement for multi-photo rooms.
 *
 * Aligning photos to each other (ICP) is weak: two listing photos of a room
 * overlap only partly, and monocular depth has no metric scale. Two things
 * every photo does share are the floor and the room's walls, both of which we
 * know from the plan:
 *
 * 1. `calibrateFromFloor`: listing photos are shot level from about 1.5 m, so a
 *    floor pixel's true inverse depth is fixed by its image row. Fitting the
 *    depth model's (affine) output to that gives each photo metric depth.
 * 2. `wallProfile` + `fitToRoomBox`: the farthest point in each image column
 *    is usually wall. Fit that profile to the room's rectangle from the plan,
 *    starting from Gemini's camera guess, and every photo lands in one frame.
 */
import { applyPose, type Pose2D } from "./geometry";
import { fitSimilarity2D } from "./merge";

export const CAMERA_HEIGHT_M = 1.5;

type P2 = [number, number];

export interface DepthCalibration {
  /** Metric depth at d = 1 and d = 0, for `unproject`'s inverse-depth mapping. */
  near: number;
  far: number;
  /** Fraction of sampled floor-region pixels consistent with a level floor. */
  inlierRatio: number;
}

/**
 * Fit metric near/far for a relative inverse-depth map from its floor pixels.
 * Returns null when the bottom of the frame doesn't look like a floor
 * (close-ups, a bed filling the frame), and callers keep their default range.
 */
export function calibrateFromFloor(
  depth: ArrayLike<number>, // 0..255, row-major
  width: number,
  height: number,
  hfovDeg: number,
  opts: { cameraHeight?: number; maxFar?: number; roomDiagonal?: number } = {},
): DepthCalibration | null {
  const h = opts.cameraHeight ?? CAMERA_HEIGHT_M;
  const maxFar = opts.maxFar ?? 20;
  const f = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  // Rows well below the horizon, across the whole width.
  const t: number[] = [], d: number[] = [];
  const r0 = Math.ceil(height * 0.58);
  const step = Math.max(1, Math.round(Math.sqrt(((height - r0) * width) / 2500)));
  for (let py = r0; py < height; py += step) {
    const inv = (py + 0.5 - height / 2) / (f * h); // 1/z if this pixel is floor
    for (let px = 0; px < width; px += step) {
      t.push(inv);
      d.push(depth[py * width + px] / 255);
    }
  }
  const n = t.length;
  if (n < 50) return null;

  // RANSAC on 1/z = α·d + β, relative tolerance (depth errors grow with distance).
  // Counter and table tops are level too and fit the same kind of line, just
  // with the wrong height. Telling them apart: under the floor hypothesis
  // nothing sits *below* the floor, while a countertop hypothesis pushes the
  // real floor pixels underground. So farther-than-floor pixels count against.
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const tol = 0.07;
  let best = { a: 0, b: 0, count: 0, score: -Infinity };
  for (let it = 0; it < 400; it++) {
    const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n);
    if (Math.abs(d[i] - d[j]) < 0.02 || Math.abs(t[i] - t[j]) < 1e-3) continue;
    const a = (t[i] - t[j]) / (d[i] - d[j]);
    if (a <= 0) continue;
    const b = t[i] - a * d[i];
    // Skip ranges no room has (e.g. "everything 3 m away", which a band of rows can fake).
    const bb = Math.max(b, 1 / maxFar);
    if (1 / (a + bb) > 4 || 1 / (a + bb) < 0.25 || 1 / bb < 1.5 / (a + bb)) continue;
    let count = 0, below = 0;
    for (let k = 0; k < n; k++) {
      const r = a * d[k] + b - t[k];
      if (Math.abs(r) < tol * t[k]) count++;
      else if (r < -2 * tol * t[k]) below++;
    }
    const score = count - 2 * below;
    if (score > best.score) best = { a, b, count, score };
  }
  if (best.count < Math.max(40, n * 0.12) || best.score < best.count * 0.5) return null;

  // Least-squares refit on the inliers.
  let sd = 0, st = 0, sdd = 0, sdt = 0, m = 0;
  for (let k = 0; k < n; k++) {
    if (Math.abs(best.a * d[k] + best.b - t[k]) >= tol * t[k]) continue;
    sd += d[k]; st += t[k]; sdd += d[k] * d[k]; sdt += d[k] * t[k]; m++;
  }
  const den = m * sdd - sd * sd;
  let a = best.a, b = best.b;
  if (Math.abs(den) > 1e-9) {
    const a2 = (m * sdt - sd * st) / den;
    if (a2 > 0) {
      a = a2;
      b = (st - a * sd) / m;
    }
  }
  b = Math.max(b, 1 / maxFar); // windows and doorways can read as "infinitely" far
  const near = 1 / (a + b), far = 1 / b;
  if (!(near > 0.25 && near < 4 && far > near * 1.5)) return null;
  // A bed or sofa filling the bottom of the frame passes the checks above but
  // blows the room up by (camera height / height above its top). Most of what
  // a photo shows is inside the room (open-plan views a bit less), so a typical
  // depth well past the room's diagonal means we fitted furniture, not floor.
  if (opts.roomDiagonal) {
    const zs: number[] = [];
    const s2 = Math.max(1, Math.round(Math.sqrt((width * height) / 4000)));
    for (let py = 0; py < height; py += s2) for (let px = 0; px < width; px += s2) zs.push(1 / (a * (depth[py * width + px] / 255) + b));
    zs.sort((p, q) => p - q);
    if (zs[Math.floor(zs.length * 0.8)] > opts.roomDiagonal * 1.2) return null;
  }
  return { near, far, inlierRatio: best.count / n };
}

/**
 * Per image column, the farthest point between knee and head height: walls
 * are behind the furniture. Input is `unproject` output (camera space).
 */
export function wallProfile(positions: Float32Array, cols: number, rows: number): P2[] {
  const ys: number[] = [];
  for (let i = 1; i < positions.length; i += 3 * 7) ys.push(positions[i]);
  ys.sort((p, q) => p - q);
  const floor = ys[Math.floor(ys.length * 0.02)] ?? -CAMERA_HEIGHT_M;
  const ceil = ys[Math.floor(ys.length * 0.98)] ?? 1;
  const span = ceil - floor;
  const lo = floor + span * 0.25, hi = ceil - span * 0.2;
  const out: P2[] = [];
  const step = Math.max(1, Math.round(cols / 160));
  for (let c = 0; c < cols; c += step) {
    const band: { r: number; i: number }[] = [];
    for (let r = 0; r < rows; r++) {
      const i = (r * cols + c) * 3;
      const y = positions[i + 1];
      if (y > lo && y < hi) band.push({ r: Math.hypot(positions[i], positions[i + 2]), i });
    }
    if (band.length < 3) continue;
    band.sort((p, q) => p.r - q.r);
    const pick = band[Math.floor((band.length - 1) * 0.85)];
    out.push([positions[pick.i], positions[pick.i + 2]]);
  }
  return out;
}

/** Room outline in room space (metres, origin at the room centroid, +z = down the plan). */
export interface RoomBox {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

function nearestOnOneBox(x: number, z: number, b: RoomBox): P2 {
  const cx = Math.min(b.x1, Math.max(b.x0, x));
  const cz = Math.min(b.z1, Math.max(b.z0, z));
  if (cx !== x || cz !== z) return [cx, cz]; // outside: the clamped point is on the outline
  const dl = x - b.x0, dr = b.x1 - x, dt = z - b.z0, db = b.z1 - z;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return [b.x0, z];
  if (m === dr) return [b.x1, z];
  if (m === dt) return [x, b.z0];
  return [x, b.z1];
}

/** Nearest point on any of the outlines. */
function nearestOnBox(x: number, z: number, boxes: RoomBox[]): P2 {
  let best: P2 = [Infinity, Infinity], bd = Infinity;
  for (const b of boxes) {
    const p = nearestOnOneBox(x, z, b);
    const d = (p[0] - x) ** 2 + (p[1] - z) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

export interface BoxFitOptions {
  /** Also fit a depth scale (use when depth isn't metric-calibrated). */
  freeScale?: boolean;
  /** Yaw seeds span ±this around the initial heading. */
  yawSearchDeg?: number;
  /** The camera may end up at most this far from its initial position. */
  maxShift?: number;
  /** A point within this distance of the outline counts as "on a wall". */
  inlierDist?: number;
}

export interface BoxFit {
  pose: Pose2D;
  /** Fraction of profile points on the room outline after / before fitting. */
  fit: number;
  initialFit: number;
  accepted: boolean;
}

const angleDiff = (a: number, b: number) => Math.abs((((a - b) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);

/**
 * Place a photo's wall profile on the room outline: ICP against the rectangle
 * from a few yaw seeds around the initial guess, keeping the best fit that
 * leaves the camera in (or at the doorway of) the room. `nearby` are the
 * outlines of the rooms it opens onto: open-plan photos mostly see those walls.
 */
export function fitToRoomBox(profile: P2[], box: RoomBox, initial: Pose2D, options: BoxFitOptions = {}, nearby: RoomBox[] = []): BoxFit {
  const boxes = [box, ...nearby];
  const yawSearch = ((options.yawSearchDeg ?? 40) * Math.PI) / 180;
  const maxShift = options.maxShift ?? Math.max(1.2, 0.35 * Math.hypot(box.x1 - box.x0, box.z1 - box.z0));
  const tau = options.inlierDist ?? 0.15;
  const margin = 0.6;

  const fitOf = (p: Pose2D) => {
    let k = 0;
    for (const s of profile) {
      const q = applyPose(p, s[0], s[1]);
      const nn = nearestOnBox(q[0], q[1], boxes);
      if (Math.hypot(nn[0] - q[0], nn[1] - q[1]) < tau) k++;
    }
    return profile.length ? k / profile.length : 0;
  };
  const allowed = (p: Pose2D) =>
    angleDiff(p.yaw, initial.yaw) <= yawSearch + 0.2 &&
    Math.hypot(p.tx - initial.tx, p.tz - initial.tz) <= maxShift &&
    p.tx > box.x0 - margin && p.tx < box.x1 + margin && p.tz > box.z0 - margin && p.tz < box.z1 + margin;

  const initialFit = fitOf(initial);
  if (profile.length < 20) return { pose: initial, fit: initialFit, initialFit, accepted: false };

  const search = (freeScale: boolean) => {
    let best = { pose: initial, fit: initialFit, score: initialFit };
    const seeds = 2 * Math.round(yawSearch / 0.17) + 1;
    for (let k = 0; k < seeds; k++) {
      const dyaw = seeds === 1 ? 0 : -yawSearch + (2 * yawSearch * k) / (seeds - 1);
      let pose: Pose2D = { ...initial, yaw: initial.yaw + dyaw };
      const iters = 25;
      for (let it = 0; it < iters; it++) {
        const radius = tau * (1 + 4 * (1 - it / iters)); // coarse to fine
        const src: P2[] = [], dst: P2[] = [];
        for (const s of profile) {
          const q = applyPose(pose, s[0], s[1]);
          const nn = nearestOnBox(q[0], q[1], boxes);
          if (Math.hypot(nn[0] - q[0], nn[1] - q[1]) < radius) {
            src.push(s);
            dst.push(nn);
          }
        }
        if (src.length < 15) break;
        let next = fitSimilarity2D(src, dst, freeScale ? undefined : initial.scale);
        if (freeScale) {
          const s = Math.min(initial.scale * 1.35, Math.max(initial.scale * 0.75, next.scale));
          if (s !== next.scale) next = fitSimilarity2D(src, dst, s);
        }
        if (!allowed(next)) break;
        pose = next;
      }
      const fit = fitOf(pose);
      // Mild preference for staying near Gemini's guess when fits are close.
      const score = fit - 0.1 * Math.hypot(pose.tx - initial.tx, pose.tz - initial.tz) - 0.03 * angleDiff(pose.yaw, initial.yaw);
      if (score > best.score) best = { pose, fit, score };
    }
    return best;
  };
  let best = search(false);
  if (options.freeScale) {
    // A free scale can also shrink a photo onto any corner, so it has to fit clearly better.
    const scaled = search(true);
    if (scaled.fit > best.fit + 0.1) best = scaled;
  }
  // Uncalibrated depth is warped, not just mis-scaled, so its fits are only trusted when near-perfect.
  const accepted = best.fit >= (options.freeScale ? 0.8 : 0.6) && best.fit >= initialFit;
  return { pose: accepted ? best.pose : initial, fit: best.fit, initialFit, accepted };
}
