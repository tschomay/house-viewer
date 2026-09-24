import { DEFAULT_INTRINSICS, farFromRoomSize, gridIndices, IDENTITY_POSE, unproject, type Intrinsics, type Pose2D } from "../geometry";
import { calibrateFromFloor, fitToRoomBox, wallProfile, type RoomBox } from "../layout-fit";
import { initialPoseFromMatch, mergeClouds } from "../merge";
import { planScale } from "../room-graph";
import type { DepthMap, ListingImage, PhotoMatch, Room, RoomGraph } from "../types";
import { readGray } from "./images";

/** One photo, lifted to 3D and placed in the room's coordinate frame. */
export interface RoomLayer {
  photo: ListingImage;
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  pose: Pose2D;
  /** Median scene depth (m) — used as the stereo convergence distance. */
  focus: number;
  /** Depth range this photo was lifted with (metric when `calibrated`). */
  far: number;
  calibrated: boolean;
  cols: number;
  rows: number;
  /** Share of this photo's wall profile on the plan's room outline, when it was fitted to it. */
  outlineFit?: number;
  registered: boolean;
  inlierRatio: number;
}

export interface RoomModel {
  room: Room;
  layers: RoomLayer[];
  /** "merged": 2+ photos registered into one frame. "single": view photos one at a time. */
  mode: "merged" | "single";
  depthSource: DepthMap["source"] | null;
}

const MESH_COLS = 200;

type BaseLayer = Omit<RoomLayer, "pose" | "registered" | "inlierRatio">;

/**
 * Lift a photo to 3D. Depth is relative, so it needs a metric range: fitted
 * from the floor when the photo shows one (see calibrateFromFloor), else the
 * room-size guess in `intr`. The box-room heuristic is never calibrated: its
 * floor is made up.
 */
export async function buildLayer(photo: ListingImage, depth: DepthMap, intr: Intrinsics): Promise<BaseLayer> {
  const gray = await readGray(depth.dataUrl, 640);
  const calib = depth.source === "heuristic" ? null : calibrateFromFloor(gray.data, gray.width, gray.height, intr.hfovDeg, { maxFar: 3 * intr.far, roomDiagonal: intr.far });
  const range = calib ? { ...intr, near: calib.near, far: calib.far } : intr;
  const stride = Math.max(1, Math.round(gray.width / MESH_COLS));
  const { positions, uvs, cols, rows } = unproject(gray.data, gray.width, gray.height, { ...range, stride });
  const zs: number[] = [];
  for (let i = 2; i < positions.length; i += 3 * 17) zs.push(-positions[i]);
  zs.sort((a, b) => a - b);
  return {
    photo,
    positions,
    uvs,
    cols,
    rows,
    indices: gridIndices(positions, cols, rows),
    focus: zs[Math.floor(zs.length / 2)] ?? 3,
    far: range.far,
    calibrated: !!calib,
  };
}

/** A room's outline in metres, relative to `origin` (a plan point), preferring printed dimensions. */
function roomBox(room: Room, origin: { x: number; y: number }, scale: { mx: number; my: number }): RoomBox | null {
  const b = room.bbox;
  if (!b) return null;
  const cx = ((b.x0 + b.x1) / 2 - origin.x) * scale.mx;
  const cz = ((b.y0 + b.y1) / 2 - origin.y) * scale.my;
  const w = room.sizeM?.width ?? (b.x1 - b.x0) * scale.mx;
  const d = room.sizeM?.depth ?? (b.y1 - b.y0) * scale.my;
  return { x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2 };
}

/** A plan placement we trust enough to put the photo in the merged room without overlap evidence. */
function isAnchored(m: PhotoMatch | undefined): boolean {
  return !!m && m.headingDeg != null && m.cameraPosition != null && (m.placed || (!m.manual && m.confidence >= 0.7));
}

export async function buildRoomModel(args: {
  room: Room;
  graph: RoomGraph;
  planAspect: number;
  photos: ListingImage[];
  matches: Record<string, PhotoMatch>;
  depth: Record<string, DepthMap>;
  tryMerge: boolean;
}): Promise<RoomModel> {
  const { room, graph, planAspect, photos, matches, depth, tryMerge } = args;
  const intr: Intrinsics = { ...DEFAULT_INTRINSICS, far: farFromRoomSize(room.sizeM) };
  const withDepth = photos.filter((p) => depth[p.id]);
  const base = await Promise.all(withDepth.map((p) => buildLayer(p, depth[p.id], intr)));
  const depthSource = withDepth.length ? depth[withDepth[0].id].source : null;

  if (!tryMerge || base.length < 2) {
    return {
      room,
      mode: "single",
      depthSource,
      layers: base.map((b) => ({ ...b, pose: IDENTITY_POSE, registered: false, inlierRatio: 0 })),
    };
  }

  const scale = planScale(graph, planAspect);
  const box = roomBox(room, room.centroid, scale);
  const nearby = room.neighbors
    .map((id) => graph.rooms.find((r) => r.id === id))
    .map((r) => r && roomBox(r, room.centroid, scale))
    .filter((b): b is RoomBox => !!b);
  // 1. Plan pose from Gemini, snapped onto the room's outline where the walls agree.
  const placed = base.map((b) => {
    const m = matches[b.photo.id];
    const initial = initialPoseFromMatch(m ?? { headingDeg: null, cameraPosition: null }, room.centroid, scale);
    if (!box || m?.headingDeg == null) return { initial, anchored: isAnchored(m), outlineFit: undefined };
    const fit = fitToRoomBox(wallProfile(b.positions, b.cols, b.rows), box, initial, { freeScale: !b.calibrated }, nearby);
    return { initial: fit.pose, anchored: fit.accepted || isAnchored(m), outlineFit: fit.accepted ? fit.fit : undefined };
  });
  // 2. Photo-to-photo ICP, only as a small final nudge once the outline has placed them.
  const snapped = placed.some((p) => p.outlineFit != null);
  const result = mergeClouds(
    base.map((b, i) => ({ id: b.photo.id, positions: b.positions, initial: placed[i].initial, anchored: placed[i].anchored })),
    snapped ? { maxYawDelta: 0.1, maxShift: 0.3 } : {},
  );
  const layers: RoomLayer[] = base.map((b, i) => ({
    ...b,
    pose: result.clouds[i].pose,
    registered: result.clouds[i].registered,
    inlierRatio: result.clouds[i].inlierRatio,
    outlineFit: placed[i].outlineFit,
  }));
  console.debug(
    "[room-model]",
    room.id,
    JSON.stringify(
      layers.map((l) => ({
        id: l.photo.label,
        pose: l.pose,
        reg: l.registered,
        inl: +l.inlierRatio.toFixed(2),
        calib: l.calibrated ? +l.far.toFixed(1) : false,
        outline: l.outlineFit == null ? null : +l.outlineFit.toFixed(2),
      })),
    ),
  );
  // Put registered photos first so the merged view opens on a photo that's in it.
  layers.sort((a, b) => Number(b.registered) - Number(a.registered));
  return { room, layers, mode: result.merged ? "merged" : "single", depthSource };
}
