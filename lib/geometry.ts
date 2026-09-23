/**
 * Depth → 3D. Pure math, no Three.js, so it's unit-testable and reusable in
 * both the stereo mesh and the merged point cloud.
 *
 * Conventions: camera at origin looking down −Z, +Y up, +X right (Three.js).
 * Depth maps are Depth-Anything style *relative inverse depth* normalized to
 * 0..1 (1 = nearest). There is no metric scale, so we map the range onto an
 * assumed [near, far] in metres — plausible for rooms and good enough for
 * stereo. When the floor plan prints room dimensions, `far` is derived from them.
 */

export interface Intrinsics {
  hfovDeg: number; // listing photos are usually wide-angle; ~75° is typical
  near: number; // metres
  far: number; // metres
}

export const DEFAULT_INTRINSICS: Intrinsics = { hfovDeg: 75, near: 0.9, far: 7 };

/** Inverse-depth value (0..1, 1 = near) → metric-ish depth along the view axis. */
export function inverseToMetric(d: number, near: number, far: number): number {
  const inv = 1 / far + Math.min(1, Math.max(0, d)) * (1 / near - 1 / far);
  return 1 / inv;
}

/** Room diagonal is a decent guess for the farthest visible wall. */
export function farFromRoomSize(size: { width: number; depth: number } | null | undefined): number {
  if (!size) return DEFAULT_INTRINSICS.far;
  return Math.min(15, Math.max(3, Math.hypot(size.width, size.depth)));
}

export interface UnprojectOptions extends Intrinsics {
  stride?: number; // sample every Nth pixel
}

/**
 * Unproject a depth map into camera-space points.
 * Returns positions (xyz) and uvs (0..1, v up — Three.js convention).
 */
export function unproject(
  depth: ArrayLike<number>, // 0..255 or 0..1 grayscale, row-major, top row first
  width: number,
  height: number,
  opts: UnprojectOptions,
): { positions: Float32Array; uvs: Float32Array; cols: number; rows: number } {
  const stride = Math.max(1, Math.floor(opts.stride ?? 1));
  const cols = Math.floor((width - 1) / stride) + 1;
  const rows = Math.floor((height - 1) / stride) + 1;
  const positions = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const fx = width / 2 / Math.tan(((opts.hfovDeg * Math.PI) / 180) / 2);
  const scale = maxOf(depth) > 1 ? 1 / 255 : 1;
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const py = Math.min(height - 1, r * stride);
    for (let c = 0; c < cols; c++, i++) {
      const px = Math.min(width - 1, c * stride);
      const z = inverseToMetric(depth[py * width + px] * scale, opts.near, opts.far);
      positions[i * 3] = ((px + 0.5 - width / 2) / fx) * z;
      positions[i * 3 + 1] = (-(py + 0.5 - height / 2) / fx) * z;
      positions[i * 3 + 2] = -z;
      uvs[i * 2] = px / (width - 1);
      uvs[i * 2 + 1] = 1 - py / (height - 1);
    }
  }
  return { positions, uvs, cols, rows };
}

function maxOf(a: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i += 97) if (a[i] > m) m = a[i];
  return m;
}

/**
 * Triangle indices for a grid mesh, skipping triangles that straddle a big
 * depth jump (otherwise foreground objects get "rubber sheet" skins stretched
 * to the wall behind them). The gaps this leaves are the classic DIBR holes;
 * a small `maxRatio` shows more holes, a large one more stretching.
 */
export function gridIndices(positions: Float32Array, cols: number, rows: number, maxRatio = 1.25): Uint32Array {
  const out: number[] = [];
  const z = (i: number) => -positions[i * 3 + 2];
  const ok = (a: number, b: number, c: number) => {
    const za = z(a), zb = z(b), zc = z(c);
    return Math.max(za, zb, zc) / Math.min(za, zb, zc) <= maxRatio;
  };
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      if (ok(a, d, b)) out.push(a, d, b);
      if (ok(b, d, e)) out.push(b, d, e);
    }
  }
  return Uint32Array.from(out);
}

/** 2D rigid-with-scale transform in the XZ (floor) plane. */
export interface Pose2D {
  yaw: number; // radians, Three.js rotation.y
  tx: number;
  tz: number;
  scale: number;
}

export const IDENTITY_POSE: Pose2D = { yaw: 0, tx: 0, tz: 0, scale: 1 };

export function applyPose(p: Pose2D, x: number, z: number): [number, number] {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  // Three.js rotation about +Y: x' = x cos + z sin, z' = −x sin + z cos
  return [p.scale * (x * c + z * s) + p.tx, p.scale * (-x * s + z * c) + p.tz];
}

/** Floor plan heading (0 = up, clockwise degrees) → Three.js yaw for a −Z-facing camera. */
export function headingToYaw(headingDeg: number): number {
  return (-headingDeg * Math.PI) / 180;
}
