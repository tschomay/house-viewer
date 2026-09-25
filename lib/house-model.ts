/**
 * Whole-house 3D model and fly-through path, from the room graph alone.
 *
 * Pure math (no Three.js), so it's unit-testable. The renderer lives in
 * components/HouseFlythrough.tsx.
 *
 * - Floors: a plan image often draws every storey side by side. Rooms are
 *   clustered by touching bounding boxes; the cluster with the entry is the
 *   ground floor, and upper floors are stacked on it, aligned by their stairs.
 * - Rooms become boxes in metres (plan bbox × plan scale, so they tile like the
 *   plan and Gemini's camera positions stay where it put them).
 * - Walls: four per room, one-sided (they face into the room). Doorways are
 *   cut where two connected rooms meet: a door between private rooms, a full
 *   opening between open-plan spaces. Exterior walls also get an outside face,
 *   and the entry gets a front door.
 * - Path: a depth-first walk over the rooms from the front door, stopping at
 *   every photo's camera position facing the way the photo was taken, so each
 *   photo is seen from exactly where it was shot. Upper floors come last, via
 *   the stairs. It opens with an aerial approach and ends rising back out.
 */
import { headingToYaw } from "./geometry";
import { planScale, repairCentroids } from "./room-graph";
import type { PhotoMatch, Room, RoomGraph } from "./types";

export const STOREY_M = 3.0;
export const WALL_H = 2.6;
/** Listing photos are shot from about this height (see CAMERA_HEIGHT_M); the fly-through flies at it too. */
export const EYE_H = 1.5;
const DOOR_W = 0.9;
const DOOR_TOP = 2.05;

export type Side = "top" | "right" | "bottom" | "left";
export const SIDES: Side[] = ["top", "right", "bottom", "left"];

export interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface HousePhoto {
  photoId: string;
  roomId: string;
  x: number;
  y: number;
  z: number;
  /** Three.js yaw (rotation.y) of the camera: heading 0 (plan up) = 0. */
  yaw: number;
  headingDeg: number;
}

export interface HouseRoom {
  id: string;
  label: string;
  type: string;
  floor: number;
  elevation: number;
  box: Box;
  /** Set when this room sits inside another (stairs drawn inside the foyer): no walls of its own. */
  parent: string | null;
  exterior: Side[];
  photos: HousePhoto[];
}

/** A hole in one room's wall. `from`/`to` run along the wall's world axis (x for top/bottom, z for left/right). */
export interface Cut {
  roomId: string;
  side: Side;
  from: number;
  to: number;
  top: number;
  kind: "door" | "open" | "front";
  /** The room on the other side (null for the front door). */
  otherId: string | null;
}

export interface WallQuad {
  roomId: string;
  side: Side;
  /** World endpoints, left → right as seen facing the wall from inside the room. */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  y0: number;
  y1: number;
  /** Where this piece sits on the whole wall (0..1, left → right; 0 = floor, 1 = ceiling), for wall art. */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** Outside face of an exterior wall (faces away from the room). */
  outside: boolean;
}

export interface StairRun {
  lowerRoomId: string;
  upperRoomId: string;
  box: Box;
  /** Along x or z. */
  axis: "x" | "z";
  y0: number;
  y1: number;
  /** Bottom and top of the flight, on the run's centre line. */
  low: [number, number];
  high: [number, number];
}

export interface HouseModel {
  rooms: HouseRoom[];
  cuts: Cut[];
  walls: WallQuad[];
  stairs: StairRun[];
  floors: { level: number; elevation: number; roomIds: string[] }[];
  /** Ground floor bounds, metres. */
  bounds: Box;
  entryId: string | null;
  front: { x: number; z: number; nx: number; nz: number } | null;
  scale: { mx: number; my: number };
}

const OPEN_TYPES = new Set(["living", "kitchen", "dining", "entry", "hallway", "stairs"]);
const SKIP_TYPES = new Set(["closet", "garage", "outdoor"]);

const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.z1 - b.z0);
function overlap(a: Box, b: Box): number {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0));
}
const cx = (b: Box) => (b.x0 + b.x1) / 2;
const cz = (b: Box) => (b.z0 + b.z1) / 2;
const isStairs = (r: { type: string; label: string }) => r.type === "stairs" || /stair/i.test(r.label);


/** Cluster rooms into storeys: rooms whose plan boxes touch (within `gap`) are on the same floor. */
export function clusterFloors(rooms: Room[], gap = 0.012): string[][] {
  const withBox = rooms.filter((r) => r.bbox);
  const parent = new Map(withBox.map((r) => [r.id, r.id]));
  const find = (id: string): string => {
    let p = parent.get(id)!;
    while (p !== parent.get(p)) p = parent.get(p)!;
    parent.set(id, p);
    return p;
  };
  for (let i = 0; i < withBox.length; i++) {
    for (let j = i + 1; j < withBox.length; j++) {
      const a = withBox[i].bbox!, b = withBox[j].bbox!;
      if (a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1) parent.set(find(withBox[i].id), find(withBox[j].id));
    }
  }
  const groups = new Map<string, string[]>();
  for (const r of withBox) (groups.get(find(r.id)) ?? groups.set(find(r.id), []).get(find(r.id))!).push(r.id);
  return [...groups.values()];
}

function groundScore(rooms: Room[]): number {
  let s = 0;
  for (const r of rooms) {
    if (r.type === "entry" || /foyer|entry/i.test(r.label)) s += 5;
    if (r.type === "garage") s += 3;
    if (r.type === "kitchen") s += 2;
    if (r.type === "living" || r.type === "dining") s += 1;
    if (r.type === "bedroom") s -= 1;
  }
  return s;
}

/** Where the flight path stops for a photo: inside its room, a little off the walls. */
function inset(b: Box, m: number): Box {
  const mx = Math.min(m, (b.x1 - b.x0) / 2 - 0.05), mz = Math.min(m, (b.z1 - b.z0) / 2 - 0.05);
  return { x0: b.x0 + mx, x1: b.x1 - mx, z0: b.z0 + mz, z1: b.z1 - mz };
}
const clampTo = (b: Box, x: number, z: number): [number, number] => [Math.min(b.x1, Math.max(b.x0, x)), Math.min(b.z1, Math.max(b.z0, z))];

export function buildHouseModel(graphIn: RoomGraph, planAspect: number, matches: Record<string, PhotoMatch>): HouseModel {
  const graph = { ...graphIn, rooms: repairCentroids(graphIn.rooms.map((r) => ({ ...r }))) };
  const scale = planScale(graph, planAspect);
  const byId = new Map(graph.rooms.map((r) => [r.id, r]));

  // 1. Floors.
  const clusters = clusterFloors(graph.rooms).map((ids) => ids.map((id) => byId.get(id)!));
  clusters.sort((a, b) => groundScore(b) - groundScore(a));
  const ground = clusters[0] ?? [];
  const bboxOf = (rs: Room[]) => ({
    x0: Math.min(...rs.map((r) => r.bbox!.x0)),
    y0: Math.min(...rs.map((r) => r.bbox!.y0)),
    x1: Math.max(...rs.map((r) => r.bbox!.x1)),
    y1: Math.max(...rs.map((r) => r.bbox!.y1)),
  });
  const floorOf = new Map<string, number>();
  const offsets: { dx: number; dy: number }[] = [];
  const floors: HouseModel["floors"] = [];
  clusters.forEach((rs, i) => {
    const basement = i > 0 && rs.some((r) => /basement|lower level/i.test(r.label));
    const level = i === 0 ? 0 : basement ? -1 : clusters.slice(1, i + 1).filter((c) => !c.some((r) => /basement|lower level/i.test(r.label))).length;
    // Align on the stairs when both floors have them; else centre on the ground floor's footprint.
    let dx = 0, dy = 0;
    if (i > 0 && ground.length) {
      const s0 = ground.find(isStairs)?.bbox, s1 = rs.find(isStairs)?.bbox;
      if (s0 && s1) {
        dx = (s0.x0 + s0.x1) / 2 - (s1.x0 + s1.x1) / 2;
        dy = (s0.y0 + s0.y1) / 2 - (s1.y0 + s1.y1) / 2;
      } else {
        const g = bboxOf(ground), u = bboxOf(rs);
        dx = (g.x0 + g.x1) / 2 - (u.x0 + u.x1) / 2;
        dy = (g.y0 + g.y1) / 2 - (u.y0 + u.y1) / 2;
      }
    }
    offsets.push({ dx, dy });
    for (const r of rs) floorOf.set(r.id, i);
    floors.push({ level, elevation: level * STOREY_M, roomIds: rs.map((r) => r.id) });
  });
  const planToWorld = (clusterIdx: number, x: number, y: number): [number, number] => {
    const o = offsets[clusterIdx] ?? { dx: 0, dy: 0 };
    return [(x + o.dx) * scale.mx, (y + o.dy) * scale.my];
  };

  // 2. Rooms.
  const rooms: HouseRoom[] = [];
  for (const r of graph.rooms) {
    if (!r.bbox || !floorOf.has(r.id)) continue;
    const ci = floorOf.get(r.id)!;
    const [x0, z0] = planToWorld(ci, r.bbox.x0, r.bbox.y0);
    const [x1, z1] = planToWorld(ci, r.bbox.x1, r.bbox.y1);
    rooms.push({ id: r.id, label: r.label, type: r.type, floor: ci, elevation: floors[ci].elevation, box: { x0, x1, z0, z1 }, parent: null, exterior: [], photos: [] });
  }
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  // Sub-rooms: mostly inside a bigger room on the same floor (stairs inside a foyer).
  for (const r of rooms) {
    const a = area(r.box);
    let best: HouseRoom | null = null;
    for (const o of rooms) {
      if (o === r || o.floor !== r.floor || area(o.box) <= a) continue;
      if (overlap(r.box, o.box) / Math.max(1e-6, a) >= 0.6 && (!best || area(o.box) < area(best.box))) best = o;
    }
    r.parent = best?.id ?? null;
  }
  const walled = (r: HouseRoom) => !r.parent;
  const resolve = (id: string) => {
    const r = roomById.get(id);
    return r?.parent ? roomById.get(r.parent)! : r;
  };

  // Photos: Gemini's (or hand-set) camera, clamped into the room.
  for (const m of Object.values(matches)) {
    if (!m.roomId || m.headingDeg == null || !m.cameraPosition) continue;
    const r0 = roomById.get(m.roomId);
    if (!r0) continue;
    const r = r0.parent ? roomById.get(r0.parent)! : r0;
    const [wx, wz] = planToWorld(r.floor, m.cameraPosition.x, m.cameraPosition.y);
    const [x, z] = clampTo(inset(r.box, 0.25), wx, wz);
    r.photos.push({ photoId: m.photoId, roomId: r.id, x, y: r.elevation + EYE_H, z, yaw: headingToYaw(m.headingDeg), headingDeg: m.headingDeg });
  }

  // 3. Exterior sides: little of what's just outside them is another room.
  for (const r of rooms) {
    if (!walled(r)) continue;
    const others = rooms.filter((o) => o !== r && o.floor === r.floor && walled(o));
    for (const side of SIDES) {
      let inside = 0;
      const n = 12;
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const [px, pz] = sidePoint(r.box, side, t, 0.35);
        if (others.some((o) => px >= o.box.x0 - 0.1 && px <= o.box.x1 + 0.1 && pz >= o.box.z0 - 0.1 && pz <= o.box.z1 + 0.1)) inside++;
      }
      if (inside / n < 0.5) r.exterior.push(side);
    }
  }

  // 4. Doorways between connected rooms on the same floor.
  const cuts: Cut[] = [];
  const links: Link[] = [];
  const seen = new Set<string>();
  const stairs: StairRun[] = [];
  for (const g of graph.rooms) {
    for (const n of g.neighbors) {
      const key = [g.id, n].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const ra = roomById.get(g.id), rb = roomById.get(n);
      if (!ra || !rb) continue;
      if (ra.floor !== rb.floor) {
        const [lo, hi] = ra.elevation <= rb.elevation ? [ra, rb] : [rb, ra];
        const box = inset(isStairs(lo) ? lo.box : isStairs(hi) ? hi.box : lo.box, 0.1);
        const axis = box.x1 - box.x0 >= box.z1 - box.z0 ? "x" : "z";
        const e1: [number, number] = axis === "x" ? [box.x0, cz(box)] : [cx(box), box.z0];
        const e2: [number, number] = axis === "x" ? [box.x1, cz(box)] : [cx(box), box.z1];
        // The flight starts at the end nearer the middle of the room it rises from.
        const lower = resolve(lo.id)!;
        const d = (e: [number, number]) => Math.hypot(e[0] - cx(lower.box), e[1] - cz(lower.box));
        const [low, high] = d(e1) <= d(e2) ? [e1, e2] : [e2, e1];
        const run: StairRun = { lowerRoomId: lower.id, upperRoomId: resolve(hi.id)!.id, box, axis, y0: lo.elevation, y1: hi.elevation, low, high };
        stairs.push(run);
        links.push({ a: run.lowerRoomId, b: run.upperRoomId, stair: run });
        continue;
      }
      const A = resolve(ra.id)!, B = resolve(rb.id)!;
      if (A === B) continue;
      const open = OPEN_TYPES.has(A.type) && OPEN_TYPES.has(B.type);
      const c = doorway(A.box, B.box, open);
      cuts.push(
        { roomId: A.id, side: c.sideA, from: c.from, to: c.to, top: c.top, kind: open ? "open" : "door", otherId: B.id },
        { roomId: B.id, side: c.sideB, from: c.from, to: c.to, top: c.top, kind: open ? "open" : "door", otherId: A.id },
      );
      links.push({ a: A.id, b: B.id, pA: c.pA, pB: c.pB, mid: c.mid });
    }
  }

  // 5. Front door: on the entry's exterior wall, preferring the plan's bottom edge (the street side, usually).
  const groundRooms = rooms.filter((r) => r.floor === 0 && walled(r));
  const entry =
    groundRooms.find((r) => r.type === "entry" || /foyer|entry/i.test(r.label)) ??
    groundRooms.find((r) => r.type === "living") ??
    groundRooms.find((r) => r.photos.length) ??
    groundRooms[0] ??
    null;
  let front: HouseModel["front"] = null;
  if (entry) {
    const side = (["bottom", "top", "left", "right"] as Side[]).find((s) => entry.exterior.includes(s));
    if (side) {
      const along = side === "top" || side === "bottom" ? cx(entry.box) : cz(entry.box);
      const half = 0.5;
      cuts.push({ roomId: entry.id, side, from: along - half, to: along + half, top: 2.1, kind: "front", otherId: null });
      const [wx, wz] = sidePoint(entry.box, side, 0.5, 0);
      const [nx, nz] = outward(side);
      front = { x: wx, z: wz, nx, nz };
    }
  }

  // 6. Wall quads.
  const walls: WallQuad[] = [];
  for (const r of rooms) {
    if (!walled(r)) continue;
    for (const side of SIDES) {
      const mine = cuts.filter((c) => c.roomId === r.id && c.side === side);
      // The front door is only open from outside: the inside face is invisible from out there
      // (walls are one-sided), and from inside the photos show where the real door is.
      walls.push(...wallPieces(r, side, mine.filter((c) => c.kind !== "front"), false));
      if (r.exterior.includes(side)) walls.push(...wallPieces(r, side, mine.filter((c) => c.kind === "front"), true));
    }
  }

  const gb = groundRooms.length ? groundRooms.map((r) => r.box) : rooms.map((r) => r.box);
  const bounds = gb.length
    ? { x0: Math.min(...gb.map((b) => b.x0)), x1: Math.max(...gb.map((b) => b.x1)), z0: Math.min(...gb.map((b) => b.z0)), z1: Math.max(...gb.map((b) => b.z1)) }
    : { x0: 0, x1: 1, z0: 0, z1: 1 };

  const model: HouseModel = { rooms, cuts, walls, stairs, floors, bounds, entryId: entry?.id ?? null, front, scale };
  linkCache.set(model, links);
  return model;
}

interface Link {
  a: string;
  b: string;
  pA?: [number, number];
  pB?: [number, number];
  mid?: [number, number];
  stair?: StairRun;
}
const linkCache = new WeakMap<HouseModel, Link[]>();

function outward(side: Side): [number, number] {
  return side === "top" ? [0, -1] : side === "bottom" ? [0, 1] : side === "left" ? [-1, 0] : [1, 0];
}

/** A point on a side (t = 0..1 along the world axis), pushed `out` metres outward. */
function sidePoint(b: Box, side: Side, t: number, out: number): [number, number] {
  const [nx, nz] = outward(side);
  const x = side === "left" ? b.x0 : side === "right" ? b.x1 : b.x0 + t * (b.x1 - b.x0);
  const z = side === "top" ? b.z0 : side === "bottom" ? b.z1 : b.z0 + t * (b.z1 - b.z0);
  return [x + nx * out, z + nz * out];
}

/**
 * Where two rooms' walls meet, and the doorway through them. Plan boxes rarely
 * touch exactly (gaps, overlaps), so the shared wall is on the axis where they
 * are most separated, and each room cuts its own wall there.
 */
export function doorway(a: Box, b: Box, open: boolean) {
  const gx = Math.max(b.x0 - a.x1, a.x0 - b.x1);
  const gz = Math.max(b.z0 - a.z1, a.z0 - b.z1);
  const vertical = gx >= gz; // shared wall runs along z (a left/right side)
  let sideA: Side, sideB: Side, lo: number, hi: number, edgeA: number, edgeB: number;
  if (vertical) {
    const bRight = cx(b) > cx(a);
    sideA = bRight ? "right" : "left";
    sideB = bRight ? "left" : "right";
    edgeA = bRight ? a.x1 : a.x0;
    edgeB = bRight ? b.x0 : b.x1;
    lo = Math.max(a.z0, b.z0);
    hi = Math.min(a.z1, b.z1);
  } else {
    const bBelow = cz(b) > cz(a);
    sideA = bBelow ? "bottom" : "top";
    sideB = bBelow ? "top" : "bottom";
    edgeA = bBelow ? a.z1 : a.z0;
    edgeB = bBelow ? b.z0 : b.z1;
    lo = Math.max(a.x0, b.x0);
    hi = Math.min(a.x1, b.x1);
  }
  const [a0, a1] = vertical ? [a.z0, a.z1] : [a.x0, a.x1];
  const [b0, b1] = vertical ? [b.z0, b.z1] : [b.x0, b.x1];
  if (hi - lo < 0.8) {
    // Barely overlapping: a door-width centred between them, kept on both walls.
    const c = Math.min(Math.min(a1, b1) - 0.45, Math.max(Math.max(a0, b0) + 0.45, (lo + hi) / 2));
    lo = c - 0.4;
    hi = c + 0.4;
  }
  let from: number, to: number, top: number;
  if (open) {
    from = lo + 0.12;
    to = hi - 0.12;
    top = WALL_H;
  } else {
    const c = (lo + hi) / 2, w = Math.min(DOOR_W, hi - lo - 0.1);
    from = c - w / 2;
    to = c + w / 2;
    top = DOOR_TOP;
  }
  const c = (from + to) / 2;
  const dirA = sideA === "right" || sideA === "bottom" ? 1 : -1; // from A towards B along the normal
  const pt = (edge: number, into: number): [number, number] => (vertical ? [edge + into, c] : [c, edge + into]);
  return {
    sideA,
    sideB,
    from,
    to,
    top,
    pA: pt(edgeA, -dirA * 0.55),
    pB: pt(edgeB, dirA * 0.55),
    mid: pt((edgeA + edgeB) / 2, 0),
  };
}

/** Split one side of a room into wall pieces around its cuts (full-height pieces, plus lintels over doors). */
function wallPieces(r: HouseRoom, side: Side, cuts: Cut[], outside: boolean): WallQuad[] {
  const b = r.box;
  const alongX = side === "top" || side === "bottom";
  const s0 = alongX ? b.x0 : b.z0, s1 = alongX ? b.x1 : b.z1;
  const len = s1 - s0;
  if (len <= 0.01) return [];
  const holes = cuts
    .map((c) => ({ from: Math.max(s0, c.from), to: Math.min(s1, c.to), top: c.top }))
    .filter((h) => h.to - h.from > 0.05)
    .sort((p, q) => p.from - q.from);
  const pieces: { from: number; to: number; y0: number; y1: number }[] = [];
  let at = s0;
  for (const h of holes) {
    if (h.from > at) pieces.push({ from: at, to: h.from, y0: 0, y1: WALL_H });
    if (h.top < WALL_H - 0.01) pieces.push({ from: Math.max(at, h.from), to: h.to, y0: h.top, y1: WALL_H });
    at = Math.max(at, h.to);
  }
  if (at < s1) pieces.push({ from: at, to: s1, y0: 0, y1: WALL_H });
  const fixed = side === "top" ? b.z0 : side === "bottom" ? b.z1 : side === "left" ? b.x0 : b.x1;
  // Seen from inside: top wall runs x0→x1, right z0→z1, bottom x1→x0, left z1→z0.
  const reversed = side === "bottom" || side === "left";
  return pieces
    .filter((p) => p.to - p.from > 0.01)
    .map((p) => {
      const [l, rgt] = reversed ? [p.to, p.from] : [p.from, p.to];
      const u = (s: number) => (reversed ? (s1 - s) / len : (s - s0) / len);
      const pt = (s: number): [number, number] => (alongX ? [s, fixed] : [fixed, s]);
      const [ax, az] = pt(l), [bx, bz] = pt(rgt);
      return {
        roomId: r.id,
        side,
        ax,
        az,
        bx,
        bz,
        y0: r.elevation + p.y0,
        y1: r.elevation + p.y1,
        u0: u(l),
        u1: u(rgt),
        v0: p.y0 / WALL_H,
        v1: p.y1 / WALL_H,
        outside,
      };
    });
}

/** A storey's name for floor pickers, from its level: "Basement", "Ground", "Floor 2"… ("House" if it's the only one). */
export function floorName(level: number, count: number) {
  if (level < 0) return level === -1 ? "Basement" : `Basement ${-level}`;
  if (count === 1) return "House";
  return level === 0 ? "Ground" : `Floor ${level + 1}`;
}

/** Wall facing `side`, as a plan heading (degrees clockwise from up). */
export const SIDE_HEADING: Record<Side, number> = { top: 0, right: 90, bottom: 180, left: 270 };

/** Doorways on each wall of a room, as fractions left → right when facing that wall (for the wall-art prompt). */
export function roomWallInfo(model: HouseModel, roomId: string) {
  const r = model.rooms.find((x) => x.id === roomId);
  if (!r) return null;
  const labels = new Map(model.rooms.map((x) => [x.id, x.label]));
  return SIDES.map((side) => {
    const alongX = side === "top" || side === "bottom";
    const s0 = alongX ? r.box.x0 : r.box.z0, s1 = alongX ? r.box.x1 : r.box.z1;
    const len = s1 - s0;
    const reversed = side === "bottom" || side === "left";
    const f = (s: number) => Math.min(1, Math.max(0, reversed ? (s1 - s) / len : (s - s0) / len));
    return {
      side,
      lengthM: +len.toFixed(2),
      exterior: r.exterior.includes(side),
      openings: model.cuts
        .filter((c) => c.roomId === roomId && c.side === side)
        .map((c) => {
          const [p, q] = [f(c.from), f(c.to)].sort((m, n) => m - n);
          return { from: +p.toFixed(2), to: +q.toFixed(2), kind: c.kind, to_room: c.otherId ? labels.get(c.otherId) ?? c.otherId : "outside" };
        }),
    };
  });
}

// ---------------------------------------------------------------------------
// Flight path
// ---------------------------------------------------------------------------

export interface PathSample {
  t: number; // seconds at 1× speed
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roomId: string | null;
  /** Highest floor index to draw (upper floors hide while you're below them). */
  floor: number;
  /** Set while paused at a photo's viewpoint. */
  photoId: string | null;
}

export interface FlightPath {
  samples: PathSample[];
  duration: number;
  /** Room visits in order, with the time you arrive (for the scrubber's chapter marks). */
  chapters: { roomId: string; t: number }[];
}

interface Way {
  x: number;
  y: number;
  z: number;
  roomId: string | null;
  floor: number;
  /** m/s for the stretch that ends here. */
  speed: number;
  /** Pause here, facing this yaw. */
  stop?: { yaw: number; dwell: number; photoId: string | null };
  /** Look at this point instead of along the path (aerial parts). */
  lookAt?: [number, number, number];
}

export const WALK_SPEED = 0.85;
const FLY_SPEED = 3.2;
const DT = 0.1;

export interface PathOptions {
  /** Seconds at each photo viewpoint at 1× speed. */
  dwell?: number;
  aerial?: boolean;
}

/**
 * Tour order: depth-first from the entry, nearest room first, stairs last on
 * each floor, so the ground floor is finished before going up.
 */
export function tourOrder(model: HouseModel): { roomId: string; via: Link | null }[] {
  const links = linkCache.get(model) ?? [];
  const rooms = new Map(model.rooms.map((r) => [r.id, r]));
  const wanted = (id: string) => {
    const r = rooms.get(id)!;
    return r.photos.length > 0 || (!SKIP_TYPES.has(r.type) && !r.parent);
  };
  // Rooms that lead somewhere worth going (so dead-end closets are skipped).
  const start = model.entryId ?? model.rooms.find((r) => !r.parent)?.id;
  if (!start) return [];
  const out: { roomId: string; via: Link | null }[] = [{ roomId: start, via: null }];
  const visited = new Set([start]);
  const worth = (id: string, from: string, seen = new Set<string>()): boolean => {
    if (wanted(id)) return true;
    seen.add(id);
    return links.some((l) => {
      const o = l.a === id ? l.b : l.b === id ? l.a : null;
      return !!o && o !== from && !seen.has(o) && !visited.has(o) && worth(o, id, seen);
    });
  };
  const neighbours = (id: string) =>
    links
      .filter((l) => l.a === id || l.b === id)
      .map((l) => ({ l, o: l.a === id ? l.b : l.a }))
      .filter(({ o }) => rooms.has(o));
  const dist = (a: string, b: string) => {
    const p = rooms.get(a)!.box, q = rooms.get(b)!.box;
    return Math.hypot(cx(p) - cx(q), cz(p) - cz(q));
  };
  // 1. Which rooms, in what order: depth-first preorder, nearest first, stairs last.
  const targets: string[] = [start];
  const visit = (id: string) => {
    const next = neighbours(id).sort((p, q) => Number(!!p.l.stair) - Number(!!q.l.stair) || dist(id, p.o) - dist(id, q.o));
    for (const { o } of next) {
      if (visited.has(o) || !worth(o, id)) continue;
      visited.add(o);
      if (wanted(o)) targets.push(o);
      visit(o);
    }
  };
  visit(start);
  // 2. Walk between consecutive targets by the shortest route (so you step back
  //    through the nearest door, not back along the way you came).
  for (let i = 1; i < targets.length; i++) {
    const route = shortestRoute(out[out.length - 1].roomId, targets[i], neighbours, dist);
    for (const step of route) out.push(step);
  }
  return out;
}

function shortestRoute(
  from: string,
  to: string,
  neighbours: (id: string) => { l: Link; o: string }[],
  dist: (a: string, b: string) => number,
): { roomId: string; via: Link }[] {
  const best = new Map<string, { d: number; prev: string | null; via: Link | null }>([[from, { d: 0, prev: null, via: null }]]);
  const open = new Set([from]);
  while (open.size) {
    const id = [...open].reduce((a, b) => (best.get(a)!.d <= best.get(b)!.d ? a : b));
    open.delete(id);
    if (id === to) break;
    for (const { l, o } of neighbours(id)) {
      // Stairs cost extra, so a floor is only left when it has to be.
      const d = best.get(id)!.d + dist(id, o) + (l.stair ? 20 : 0);
      if (!best.has(o) || d < best.get(o)!.d) {
        best.set(o, { d, prev: id, via: l });
        open.add(o);
      }
    }
  }
  if (!best.has(to)) return [];
  const route: { roomId: string; via: Link }[] = [];
  for (let id: string | null = to; id && id !== from; id = best.get(id)!.prev) route.unshift({ roomId: id, via: best.get(id)!.via! });
  return route;
}

export function buildFlightPath(model: HouseModel, opts: PathOptions = {}): FlightPath {
  const dwell = opts.dwell ?? 2.5;
  const rooms = new Map(model.rooms.map((r) => [r.id, r]));
  const order = tourOrder(model);
  const ways: Way[] = [];
  const b = model.bounds;
  const center: [number, number, number] = [cx(b), 0, cz(b)];
  const radius = Math.max(4, Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2);
  const eye = (r: HouseRoom) => r.elevation + EYE_H;
  const push = (w: Way) => ways.push(w);

  const first = order[0] && rooms.get(order[0].roomId);
  if (!first) return { samples: [], duration: 0, chapters: [] };

  // Aerial approach to the front door (or straight down into the entry).
  if (opts.aerial !== false) {
    const f = model.front;
    const dir: [number, number] = f ? [f.nx, f.nz] : [0, 1];
    const side: [number, number] = [-dir[1], dir[0]];
    const lookHouse: [number, number, number] = [center[0], 0.5, center[2]];
    push({ x: center[0] + dir[0] * radius * 1.7 + side[0] * radius * 0.9, y: radius * 1.5, z: center[2] + dir[1] * radius * 1.7 + side[1] * radius * 0.9, roomId: null, floor: 0, speed: FLY_SPEED, lookAt: lookHouse });
    push({ x: center[0] + dir[0] * radius * 1.2 - side[0] * radius * 0.2, y: radius * 0.95, z: center[2] + dir[1] * radius * 1.2 - side[1] * radius * 0.2, roomId: null, floor: 0, speed: FLY_SPEED, lookAt: lookHouse });
    if (f) {
      push({ x: f.x + f.nx * 6, y: EYE_H + 1.2, z: f.z + f.nz * 6, roomId: null, floor: 0, speed: FLY_SPEED, lookAt: [f.x, EYE_H, f.z] });
      push({ x: f.x + f.nx * 2.2, y: EYE_H, z: f.z + f.nz * 2.2, roomId: null, floor: 0, speed: WALK_SPEED * 1.6 });
      push({ x: f.x - f.nx * 0.6, y: EYE_H, z: f.z - f.nz * 0.6, roomId: first.id, floor: 0, speed: WALK_SPEED });
    } else {
      push({ x: cx(first.box), y: first.elevation + WALL_H + 3, z: cz(first.box), roomId: null, floor: 0, speed: FLY_SPEED, lookAt: [cx(first.box), first.elevation, cz(first.box) - 1] });
      push({ x: cx(first.box), y: eye(first), z: cz(first.box) + 0.01, roomId: first.id, floor: first.floor, speed: WALK_SPEED });
    }
  } else {
    push({ x: cx(first.box), y: eye(first), z: cz(first.box), roomId: first.id, floor: first.floor, speed: WALK_SPEED });
  }

  const shown = new Set<string>();
  const chapters: { roomId: string; wayIndex: number }[] = [];
  const cur = () => ways[ways.length - 1];

  for (let i = 0; i < order.length; i++) {
    const room = rooms.get(order[i].roomId)!;
    const exit = order[i + 1]?.via ?? null;
    // Where we'll leave from (inside this room).
    const exitPt = exit ? linkPoint(exit, room.id, rooms) : null;
    if (!shown.has(room.id)) {
      shown.add(room.id);
      chapters.push({ roomId: room.id, wayIndex: ways.length - 1 });
      const inner = inset(room.box, 0.35);
      const stops = room.photos.map((p) => ({ ...p, pos: clampTo(inner, p.x, p.z) }));
      if (stops.length) {
        // Greedy nearest-next from where we came in.
        let at: [number, number] = [cur().x, cur().z];
        while (stops.length) {
          stops.sort((p, q) => Math.hypot(p.pos[0] - at[0], p.pos[1] - at[1]) - Math.hypot(q.pos[0] - at[0], q.pos[1] - at[1]));
          const s = stops.shift()!;
          push({ x: s.pos[0], y: eye(room), z: s.pos[1], roomId: room.id, floor: room.floor, speed: WALK_SPEED, stop: { yaw: s.yaw, dwell, photoId: s.photoId } });
          at = s.pos;
        }
      } else if (!room.parent) {
        // No photos: step in and look across the room.
        const [ex, ez] = [cur().x, cur().z];
        const [px, pz] = clampTo(inner, ex + (cx(room.box) - ex) * 0.7, ez + (cz(room.box) - ez) * 0.7);
        const yaw = Math.atan2(-(cx(room.box) - ex), -(cz(room.box) - ez));
        push({ x: px, y: eye(room), z: pz, roomId: room.id, floor: room.floor, speed: WALK_SPEED, stop: { yaw: Number.isFinite(yaw) ? yaw : 0, dwell: dwell * 0.6, photoId: null } });
      }
    }
    if (!exit || !exitPt) continue;
    const next = rooms.get(order[i + 1].roomId)!;
    if (exit.stair) {
      const s = exit.stair;
      const up = next.elevation > room.elevation;
      const [lowEnd, highEnd] = [s.low, s.high];
      const upper = rooms.get(s.upperRoomId)!;
      const upperIn = clampTo(inset(upper.box, 0.4), highEnd[0], highEnd[1]);
      const legs: [number, number, number, number][] = [
        [lowEnd[0], s.y0 + EYE_H, lowEnd[1], s.y0 === room.elevation ? room.floor : next.floor],
        [highEnd[0], s.y1 + EYE_H, highEnd[1], upper.floor],
        [upperIn[0], s.y1 + EYE_H, upperIn[1], upper.floor],
      ];
      if (!up) legs.reverse();
      const lower = rooms.get(s.lowerRoomId)!;
      for (const [x, y, z, fl] of legs) {
        // Above the lower storey's ceiling, the upper floor has to be drawn.
        const floorShown = Math.max(fl, y > lower.elevation + WALL_H - 0.3 ? upper.floor : lower.floor);
        push({ x, y, z, roomId: floorShown === upper.floor ? upper.id : lower.id, floor: floorShown, speed: WALK_SPEED * 0.8 });
      }
      continue;
    }
    const entryPt = linkPoint(exit, next.id, rooms)!;
    push({ x: exitPt[0], y: eye(room), z: exitPt[1], roomId: room.id, floor: room.floor, speed: WALK_SPEED });
    push({ x: entryPt[0], y: eye(next), z: entryPt[1], roomId: next.id, floor: next.floor, speed: WALK_SPEED });
  }

  // Rise out through the (open) roof and circle back to the overview.
  if (opts.aerial !== false) {
    const last = cur();
    const lastFloor = last.floor;
    push({ x: last.x, y: last.y + 1.2, z: last.z, roomId: null, floor: lastFloor, speed: WALK_SPEED * 1.5, lookAt: [last.x + 0.01, 0, last.z + 2] });
    push({ x: center[0] + radius * 0.4, y: radius * 1.4 + (rooms.get(last.roomId ?? "")?.elevation ?? 0), z: center[2] + radius * 1.3, roomId: null, floor: lastFloor, speed: FLY_SPEED, lookAt: [center[0], 0, center[2]] });
  }

  return sampleWays(ways, chapters);
}

function linkPoint(l: Link, roomId: string, rooms: Map<string, HouseRoom>): [number, number] | null {
  if (l.stair) {
    const r = rooms.get(roomId)!;
    return [cx(l.stair.box), cz(l.stair.box)].map((v, i) => (i === 0 ? Math.min(r.box.x1, Math.max(r.box.x0, v)) : Math.min(r.box.z1, Math.max(r.box.z0, v)))) as [number, number];
  }
  if (l.a === roomId) return l.pA!;
  if (l.b === roomId) return l.pB!;
  return null;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Centripetal Catmull-Rom through the waypoints, resampled every DT seconds, with pauses and look directions. */
function sampleWays(ways: Way[], chapterWays: { roomId: string; wayIndex: number }[]): FlightPath {
  if (ways.length < 2) {
    const w = ways[0];
    return w
      ? { samples: [{ t: 0, x: w.x, y: w.y, z: w.z, yaw: 0, pitch: 0, roomId: w.roomId, floor: w.floor, photoId: null }], duration: 0, chapters: [] }
      : { samples: [], duration: 0, chapters: [] };
  }
  // Dense polyline per segment, then walk it at each segment's speed.
  type P = { x: number; y: number; z: number; seg: number };
  const pts = ways;
  const dense: P[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const n = Math.max(4, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z) / 0.05));
    for (let k = 0; k < n; k++) {
      const [x, y, z] = catmull(p0, p1, p2, p3, k / n);
      dense.push({ x, y, z, seg: i });
    }
  }
  dense.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, z: pts[pts.length - 1].z, seg: pts.length - 2 });

  // Time at each dense point, including pauses at stops.
  const times: number[] = [0];
  const stopAt = new Map<number, number>(); // dense index → waypoint index with a stop
  let t = 0;
  for (let j = 1; j < dense.length; j++) {
    const a = dense[j - 1], p = dense[j];
    t += Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) / ways[p.seg + 1].speed;
    const isEnd = j === dense.length - 1 || dense[j + 1].seg !== p.seg;
    if (isEnd && ways[p.seg + 1].stop) {
      stopAt.set(j, p.seg + 1);
      times.push(t);
      t += ways[p.seg + 1].stop!.dwell;
    } else times.push(t);
  }
  const duration = t;

  // Resample on a fixed clock.
  const samples: PathSample[] = [];
  let j = 0;
  const stopIdx = [...stopAt.keys()];
  for (let s = 0; s <= duration + 1e-6; s += DT) {
    while (j < dense.length - 2 && times[j + 1] <= s) j++;
    const pausedAt = stopIdx.find((k) => s >= times[k] && s <= times[k] + ways[stopAt.get(k)!].stop!.dwell);
    let x: number, y: number, z: number, seg: number;
    if (pausedAt != null) {
      ({ x, y, z, seg } = dense[pausedAt]);
    } else {
      const a = dense[j], b = dense[Math.min(dense.length - 1, j + 1)];
      const span = Math.max(1e-6, times[j + 1] - times[j]);
      const f = Math.min(1, Math.max(0, (s - times[j]) / span));
      x = a.x + (b.x - a.x) * f;
      y = a.y + (b.y - a.y) * f;
      z = a.z + (b.z - a.z) * f;
      seg = b.seg;
    }
    const from = ways[seg], w = ways[Math.min(ways.length - 1, seg + 1)];
    // Height never overshoots a stretch's ends (the spline would dip below eye level into the floor).
    y = Math.min(Math.max(from.y, w.y), Math.max(Math.min(from.y, w.y), y));
    // Labelled with the nearer end: walking in through a door, you're outside until you're through it.
    const nearer = Math.hypot(x - from.x, z - from.z) < Math.hypot(x - w.x, z - w.z) ? from : w;
    const stopWay = pausedAt != null ? ways[stopAt.get(pausedAt)!] : null;
    samples.push({ t: s, x, y, z, yaw: 0, pitch: 0, roomId: nearer.roomId, floor: Math.max(from.floor, w.floor), photoId: stopWay?.stop?.photoId ?? null });
  }

  // Look direction: along the path, looking where you'll be ~1 s ahead; at aerial waypoints, at their target;
  // turning to each photo's heading as you arrive at its viewpoint.
  const yaws: number[] = [], pitches: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const w = wayAt(samples, ways, i, dense, times);
    if (w?.lookAt) {
      const [lx, ly, lz] = w.lookAt;
      yaws.push(Math.atan2(-(lx - s.x), -(lz - s.z)));
      pitches.push(Math.atan2(ly - s.y, Math.hypot(lx - s.x, lz - s.z)));
      continue;
    }
    let k = i + 1;
    while (k < samples.length - 1 && Math.hypot(samples[k].x - s.x, samples[k].z - s.z) < 0.9) k++;
    const dx = samples[k].x - s.x, dz = samples[k].z - s.z;
    yaws.push(Math.hypot(dx, dz) > 0.05 ? Math.atan2(-dx, -dz) : (yaws[i - 1] ?? 0));
    pitches.push(Math.max(-0.35, Math.min(0.35, Math.atan2(samples[k].y - s.y, Math.max(0.3, Math.hypot(dx, dz))) * 0.6)));
  }
  // Blend towards photo headings around stops.
  const stopTimes = [...stopAt.entries()].map(([k, wi]) => ({ t0: times[k], t1: times[k] + ways[wi].stop!.dwell, yaw: ways[wi].stop!.yaw }));
  const RAMP = 1.6;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    let best: { w: number; yaw: number } | null = null;
    for (const st of stopTimes) {
      const d = s.t < st.t0 ? st.t0 - s.t : s.t > st.t1 ? s.t - st.t1 : 0;
      const wgt = d >= RAMP ? 0 : 1 - smooth(d / RAMP);
      if (wgt > 0 && (!best || wgt > best.w)) best = { w: wgt, yaw: st.yaw };
    }
    if (best) {
      yaws[i] = yaws[i] + wrap(best.yaw - yaws[i]) * best.w;
      pitches[i] *= 1 - best.w;
    }
  }
  // Unwrap and smooth (forward-backward), so turns are gentle and never spin the long way round.
  for (let i = 1; i < yaws.length; i++) yaws[i] = yaws[i - 1] + wrap(yaws[i] - yaws[i - 1]);
  const sm = (a: number[], k: number) => {
    for (let i = 1; i < a.length; i++) a[i] = a[i - 1] + (a[i] - a[i - 1]) * k;
    for (let i = a.length - 2; i >= 0; i--) a[i] = a[i + 1] + (a[i] - a[i + 1]) * k;
  };
  const pinned = samples.map((s) => s.photoId);
  const keep = yaws.slice();
  sm(yaws, 0.25);
  sm(pitches, 0.25);
  samples.forEach((s, i) => {
    // At a viewpoint, face exactly the photo's way (smoothing must not shift it).
    s.yaw = pinned[i] ? keep[i] : yaws[i];
    s.pitch = pitches[i];
  });

  const chapters = chapterWays.map(({ roomId, wayIndex }) => {
    const denseIdx = dense.findIndex((p) => p.seg + 1 >= wayIndex + 1);
    return { roomId, t: denseIdx >= 0 ? times[denseIdx] : 0 };
  });
  return { samples, duration, chapters };
}

function wayAt(samples: PathSample[], ways: Way[], i: number, dense: { seg: number }[], times: number[]): Way | undefined {
  // The waypoint this sample is heading to.
  const t = samples[i].t;
  let j = 0;
  while (j < dense.length - 1 && times[j + 1] <= t) j++;
  return ways[Math.min(ways.length - 1, dense[j].seg + 1)];
}

const smooth = (x: number) => x * x * (3 - 2 * x);

function catmull(p0: Way, p1: Way, p2: Way, p3: Way, t: number): [number, number, number] {
  // Centripetal parameterization: no loops or cusps near tight doorways.
  const d = (a: Way, b: Way) => Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)));
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const out: [number, number, number] = [0, 0, 0];
  const keys = ["x", "y", "z"] as const;
  keys.forEach((key, i) => {
    const A1 = ((t1 - u) / (t1 - t0)) * p0[key] + ((u - t0) / (t1 - t0)) * p1[key];
    const A2 = ((t2 - u) / (t2 - t1)) * p1[key] + ((u - t1) / (t2 - t1)) * p2[key];
    const A3 = ((t3 - u) / (t3 - t2)) * p2[key] + ((u - t2) / (t3 - t2)) * p3[key];
    const B1 = ((t2 - u) / (t2 - t0)) * A1 + ((u - t0) / (t2 - t0)) * A2;
    const B2 = ((t3 - u) / (t3 - t1)) * A2 + ((u - t1) / (t3 - t1)) * A3;
    out[i] = ((t2 - u) / (t2 - t1)) * B1 + ((u - t1) / (t2 - t1)) * B2;
  });
  return out;
}

/** Interpolated camera at time `t` (seconds at 1×). */
export function sampleAt(path: FlightPath, t: number): PathSample | null {
  const s = path.samples;
  if (!s.length) return null;
  const f = Math.min(s.length - 1, Math.max(0, t / DT));
  const i = Math.floor(f), k = f - i;
  const a = s[i], b = s[Math.min(s.length - 1, i + 1)];
  return {
    t,
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * k,
    yaw: a.yaw + (b.yaw - a.yaw) * k,
    pitch: a.pitch + (b.pitch - a.pitch) * k,
    roomId: k < 0.5 ? a.roomId : b.roomId,
    floor: Math.max(a.floor, b.floor),
    photoId: a.photoId ?? b.photoId,
  };
}
