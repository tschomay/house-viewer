import { DEFAULT_INTRINSICS, farFromRoomSize, gridIndices, IDENTITY_POSE, unproject, type Intrinsics, type Pose2D } from "../geometry";
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

export async function buildLayer(photo: ListingImage, depth: DepthMap, intr: Intrinsics): Promise<Omit<RoomLayer, "pose" | "registered" | "inlierRatio">> {
  const gray = await readGray(depth.dataUrl, 640);
  const stride = Math.max(1, Math.round(gray.width / MESH_COLS));
  const { positions, uvs, cols, rows } = unproject(gray.data, gray.width, gray.height, { ...intr, stride });
  const zs: number[] = [];
  for (let i = 2; i < positions.length; i += 3 * 17) zs.push(-positions[i]);
  zs.sort((a, b) => a - b);
  return { photo, positions, uvs, indices: gridIndices(positions, cols, rows), focus: zs[Math.floor(zs.length / 2)] ?? 3 };
}

/** A plan placement we trust enough to put the photo in the merged room without overlap evidence. */
function isAnchored(m: PhotoMatch | undefined): boolean {
  return !!m && m.headingDeg != null && m.cameraPosition != null && (m.manual ? false : m.confidence >= 0.7);
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
  const result = mergeClouds(
    base.map((b) => ({
      id: b.photo.id,
      positions: b.positions,
      initial: initialPoseFromMatch(matches[b.photo.id] ?? { headingDeg: null, cameraPosition: null }, room.centroid, scale),
      anchored: isAnchored(matches[b.photo.id]),
    })),
  );
  const layers: RoomLayer[] = base.map((b, i) => ({
    ...b,
    pose: result.clouds[i].pose,
    registered: result.clouds[i].registered,
    inlierRatio: result.clouds[i].inlierRatio,
  }));
  console.debug(
    "[room-model]",
    room.id,
    JSON.stringify(layers.map((l) => ({ id: l.photo.label, pose: l.pose, reg: l.registered, inl: +l.inlierRatio.toFixed(2) }))),
  );
  // Put registered photos first so the merged view opens on a photo that's in it.
  layers.sort((a, b) => Number(b.registered) - Number(a.registered));
  return { room, layers, mode: result.merged ? "merged" : "single", depthSource };
}
