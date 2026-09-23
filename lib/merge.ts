/**
 * Best-effort multi-photo room reconstruction.
 *
 * 1. Initial pose per photo from Gemini's camera heading + position on the
 *    floor plan (scaled to metres using printed room dimensions if available).
 * 2. Refine each photo against the growing merged cloud with 2D ICP in the
 *    floor plane (yaw + translation + scale; floors are level and monocular
 *    depth has no absolute scale).
 * 3. Accept a photo only if enough of its points land near the existing cloud
 *    after refinement. Otherwise it's reported as unregistered and the UI
 *    shows it on its own (the single-photo stereo fallback).
 */
import { applyPose, headingToYaw, IDENTITY_POSE, type Pose2D } from "./geometry";

export interface CloudInput {
  id: string;
  /** Camera-space points (xyz), camera at origin looking −Z. */
  positions: Float32Array;
  /** Initial guess for the camera's pose in room space. */
  initial: Pose2D;
  /**
   * True when `initial` comes from a confident floor-plan placement (Gemini
   * gave a heading and position). Such photos are placed even if they barely
   * overlap the others; ICP only nudges them.
   */
  anchored?: boolean;
}

export interface RegisteredCloud {
  id: string;
  pose: Pose2D;
  /** Fraction of this photo's wall points that land near already-placed points. */
  inlierRatio: number;
  /** ICP moved it from the plan pose (overlap improved). */
  refined: boolean;
  registered: boolean;
}

export interface MergeResult {
  clouds: RegisteredCloud[];
  /** True if at least two photos ended up in the same frame. */
  merged: boolean;
}

export interface MergeOptions {
  iterations?: number;
  inlierDist?: number; // metres
  /** Unanchored photos need at least this much overlap after ICP. */
  minInlierRatio?: number;
  samples?: number;
  /** ICP may move a photo at most this far from its initial pose. */
  maxYawDelta?: number; // radians
  maxShift?: number; // metres
}

type P2 = [number, number];

/**
 * Project to the floor plane, keeping only a horizontal band between floor and
 * ceiling (walls and furniture). Floor/ceiling points smear across the whole
 * room footprint in 2D and would pull ICP towards nonsense.
 */
export function floorProjection(positions: Float32Array, samples: number): P2[] {
  const n = positions.length / 3;
  const step = Math.max(1, Math.floor(n / samples));
  const ys: number[] = [];
  for (let i = 0; i < n; i += step) ys.push(positions[i * 3 + 1]);
  ys.sort((a, b) => a - b);
  const floor = ys[Math.floor(ys.length * 0.02)] ?? -1.5;
  const ceil = ys[Math.floor(ys.length * 0.98)] ?? 1;
  const span = ceil - floor;
  const lo = floor + span * 0.2;
  const hi = ceil - span * 0.25;
  const out: P2[] = [];
  for (let i = 0; i < n; i += step) {
    const y = positions[i * 3 + 1];
    if (y > lo && y < hi) out.push([positions[i * 3], positions[i * 3 + 2]]);
  }
  return out;
}

class Grid2D {
  private cells = new Map<string, P2[]>();
  constructor(private size: number) {}
  private key(x: number, z: number) {
    return `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`;
  }
  add(p: P2) {
    const k = this.key(p[0], p[1]);
    const cell = this.cells.get(k);
    if (cell) cell.push(p);
    else this.cells.set(k, [p]);
  }
  nearest(x: number, z: number, maxDist: number): P2 | null {
    const cx = Math.floor(x / this.size), cz = Math.floor(z / this.size);
    const r = Math.ceil(maxDist / this.size);
    let best: P2 | null = null;
    let bestD = maxDist * maxDist;
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        for (const p of this.cells.get(`${cx + i},${cz + j}`) ?? []) {
          const d = (p[0] - x) ** 2 + (p[1] - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
      }
    }
    return best;
  }
}

/**
 * Least-squares 2D fit mapping src → dst (Umeyama). With `fixedScale` the
 * scale is held (rigid fit); otherwise it's estimated too.
 */
export function fitSimilarity2D(src: P2[], dst: P2[], fixedScale?: number): Pose2D {
  const n = src.length;
  let msx = 0, msz = 0, mdx = 0, mdz = 0;
  for (let i = 0; i < n; i++) {
    msx += src[i][0]; msz += src[i][1]; mdx += dst[i][0]; mdz += dst[i][1];
  }
  msx /= n; msz /= n; mdx /= n; mdz /= n;
  let a = 0, b = 0, varS = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - msx, sz = src[i][1] - msz;
    const dx = dst[i][0] - mdx, dz = dst[i][1] - mdz;
    a += sx * dx + sz * dz; // cos term
    b += sx * dz - sz * dx; // −sin term in applyPose's convention
    varS += sx * sx + sz * sz;
  }
  const yaw = Math.atan2(-b, a);
  const scale = fixedScale ?? (varS > 0 ? Math.hypot(a, b) / varS : 1);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    yaw,
    scale,
    tx: mdx - scale * (msx * c + msz * s),
    tz: mdz - scale * (-msx * s + msz * c),
  };
}

function angleDiff(a: number, b: number): number {
  const d = (((a - b) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.abs(d);
}

/** Rigid ICP in the floor plane, bounded to a neighbourhood of the initial pose. */
export function icp2D(
  src: P2[],
  target: Grid2D,
  initial: Pose2D,
  opts: Required<MergeOptions>,
): { pose: Pose2D; inlierRatio: number; initialRatio: number } {
  const score = (p: Pose2D) => {
    let inliers = 0;
    for (const s of src) {
      const q = applyPose(p, s[0], s[1]);
      if (target.nearest(q[0], q[1], opts.inlierDist)) inliers++;
    }
    return src.length ? inliers / src.length : 0;
  };
  const initialRatio = score(initial);
  const within = (p: Pose2D) =>
    angleDiff(p.yaw, initial.yaw) <= opts.maxYawDelta && Math.hypot(p.tx - initial.tx, p.tz - initial.tz) <= opts.maxShift;

  let pose = { ...initial };
  for (let it = 0; it < opts.iterations; it++) {
    // Coarse-to-fine: accept far matches early, tighten later.
    const radius = opts.inlierDist * (1 + 3 * (1 - it / opts.iterations));
    const s: P2[] = [], d: P2[] = [];
    for (const p of src) {
      const q = applyPose(pose, p[0], p[1]);
      const nn = target.nearest(q[0], q[1], radius);
      if (nn) {
        s.push(p);
        d.push(nn);
      }
    }
    if (s.length < 20) break;
    const next = fitSimilarity2D(s, d, initial.scale);
    if (!within(next)) break;
    pose = next;
  }
  const refined = score(pose);
  // Only move off the plan pose if overlap clearly improved.
  return refined >= initialRatio + 0.05 ? { pose, inlierRatio: refined, initialRatio } : { pose: { ...initial }, inlierRatio: initialRatio, initialRatio };
}

export function mergeClouds(inputs: CloudInput[], options: MergeOptions = {}): MergeResult {
  const opts: Required<MergeOptions> = {
    iterations: options.iterations ?? 30,
    inlierDist: options.inlierDist ?? 0.15,
    minInlierRatio: options.minInlierRatio ?? 0.3,
    samples: options.samples ?? 4000,
    maxYawDelta: options.maxYawDelta ?? 0.35,
    maxShift: options.maxShift ?? 0.8,
  };
  if (inputs.length === 0) return { clouds: [], merged: false };

  // Anchor on a confidently placed photo if there is one.
  const anchorIdx = Math.max(0, inputs.findIndex((i) => i.anchored));
  const order = [anchorIdx, ...inputs.map((_, i) => i).filter((i) => i !== anchorIdx)];

  const grid = new Grid2D(opts.inlierDist);
  const results = new Map<number, RegisteredCloud>();
  for (const idx of order) {
    const input = inputs[idx];
    const pts = floorProjection(input.positions, opts.samples);
    if (idx === anchorIdx) {
      results.set(idx, { id: input.id, pose: input.initial, inlierRatio: 1, refined: false, registered: true });
      for (const p of pts) grid.add(applyPose(input.initial, p[0], p[1]));
      continue;
    }
    const { pose, inlierRatio } = icp2D(pts, grid, input.initial, opts);
    const refined = pose !== input.initial && (pose.yaw !== input.initial.yaw || pose.tx !== input.initial.tx || pose.tz !== input.initial.tz);
    const registered = !!input.anchored || inlierRatio >= opts.minInlierRatio;
    results.set(idx, { id: input.id, pose, inlierRatio, refined, registered });
    if (registered) for (const p of pts) grid.add(applyPose(pose, p[0], p[1]));
  }
  const clouds = inputs.map((_, i) => results.get(i)!);
  return { clouds, merged: clouds.filter((c) => c.registered).length >= 2 };
}

/**
 * Initial pose from a floor-plan match. `scale` converts normalized plan
 * coordinates to metres; the room centroid becomes the room-space origin.
 */
export function initialPoseFromMatch(
  match: { headingDeg: number | null; cameraPosition: { x: number; y: number } | null },
  roomCentroid: { x: number; y: number },
  scale: { mx: number; my: number },
): Pose2D {
  const pos = match.cameraPosition ?? roomCentroid;
  return {
    ...IDENTITY_POSE,
    yaw: match.headingDeg == null ? 0 : headingToYaw(match.headingDeg),
    tx: (pos.x - roomCentroid.x) * scale.mx,
    tz: (pos.y - roomCentroid.y) * scale.my,
  };
}
