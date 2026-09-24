"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { DEFAULT_INTRINSICS } from "@/lib/geometry";
import { sampleAt, SIDES, WALL_H, type FlightPath, type HouseModel, type HouseRoom } from "@/lib/house-model";
import type { ListingImage, WallArt } from "@/lib/types";
import type { StereoLayout } from "./StereoViewer";

/** A photo lifted to 3D from its depth map (camera space: camera at origin looking −Z), see buildLayer. */
export interface DepthLayer {
  photoId: string;
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface FlyState {
  t: number;
  roomId: string | null;
  photoId: string | null;
}

interface Props {
  model: HouseModel;
  path: FlightPath;
  photos: Map<string, ListingImage>;
  wallArt: Record<string, WallArt>;
  /** Per-room colours sampled from the photos (see roomPalette). */
  palette: Record<string, RoomColors>;
  /** Depth meshes for photos that have depth maps: shown near their viewpoints, so furniture stands out in 3D. */
  depthLayers: DepthLayer[];
  layout: StereoLayout;
  strength: number;
  pairWidth: number;
  playing: boolean;
  /** Playback rate: 1 = walking pace. */
  speed: number;
  /** Jump to a time; `n` changes on every request so the same time can be sought twice. */
  seek: { t: number; n: number };
  /** Bumped to reset the look-around offset. */
  recenter: number;
  gyro: boolean;
  onState: (s: FlyState) => void;
  onEnd: () => void;
  onTap?: () => void;
  /** Called once with a function that starts an immersive VR session (null if unsupported). */
  onXr?: (enter: (() => Promise<void>) | null) => void;
}

export interface RoomColors {
  wall: string;
  floor: string;
  ceiling: string;
}

const EYE_SEP = 0.064;
const MAX_PHOTOS = 6;
const HFOV = 80; // a little wider than the photos, for a sense of space

/**
 * The whole house in 3D. Each room is a box with doorways cut in its walls.
 * Its surfaces are painted by projecting the room's listing photos back from
 * where they were taken (projective texturing), so from a photo's viewpoint the
 * view *is* the photo. Walls the photos never saw show AI wall art (or paint
 * colours sampled from the photos, without it). The camera follows the flight
 * path; drag, tilt or a VR headset add look-around on top.
 */
export default function HouseFlythrough(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  // Playback position and last handled seek, kept across scene rebuilds (new wall art rebuilds the scene).
  const clockRef = useRef({ t: 0, seekN: -1 });
  useEffect(() => {
    live.current = props;
  });
  const { model, path, photos, wallArt, palette, depthLayers } = props;

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.autoClear = false;
    renderer.xr.enabled = true;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";

    const scene = new THREE.Scene();
    const sky = new THREE.Color("#b8cde0");
    scene.background = sky;
    scene.fog = new THREE.Fog(sky, 40, 140);
    const disposables: { dispose(): void }[] = [];
    const loader = new THREE.TextureLoader();
    const aniso = renderer.capabilities.getMaxAnisotropy();
    const tex = (url: string) => {
      const t = loader.load(url);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = aniso;
      disposables.push(t);
      return t;
    };
    const photoTex = new Map<string, THREE.Texture>();
    const photoTexture = (id: string) => {
      if (!photoTex.has(id)) photoTex.set(id, tex(photos.get(id)!.dataUrl));
      return photoTex.get(id)!;
    };

    // Lights only matter for the outside of the house (the rooms are painted with photos).
    scene.add(new THREE.HemisphereLight("#eef4ff", "#6b6250", 1.6));
    const sun = new THREE.DirectionalLight("#fff6e8", 1.4);
    sun.position.set(-30, 50, 20);
    scene.add(sun);

    const b = model.bounds;
    const center = new THREE.Vector3((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(160, 48).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: "#7d8b63" }),
    );
    ground.position.set(center.x, -0.03, center.z);
    scene.add(ground);
    disposables.push(ground.geometry, ground.material as THREE.Material);

    const floorGroups = model.floors.map(() => {
      const g = new THREE.Group();
      scene.add(g);
      return g;
    });
    const upperStairs = new Set(model.stairs.map((s) => s.upperRoomId));
    const fallbackPalette: RoomColors = { wall: "#d9d3c7", floor: "#9c8468", ceiling: "#eeeeea" };
    const updaters: ((cam: THREE.Vector3) => void)[] = [];

    for (const room of model.rooms) {
      if (room.parent) continue;
      const colors = palette[room.id] ?? fallbackPalette;
      const art = wallArt[room.id];
      const quads = model.walls.filter((w) => w.roomId === room.id && !w.outside);
      // The top of a stairwell is open to the floor below.
      const withFloor = !upperStairs.has(room.id) || room.floor === 0;
      const { mesh, update } = roomMesh(room, quads, colors, art ? tex(art.dataUrl) : null, withFloor, photoTexture, photos, disposables);
      floorGroups[room.floor].add(mesh);
      updaters.push(update);
    }

    // Outside faces of exterior walls: plain siding, so the house reads as a building from the air.
    const outside = model.walls.filter((w) => w.outside);
    if (outside.length) {
      const mat = new THREE.MeshLambertMaterial({ color: "#d8cfbf" });
      const byFloor = new Map<number, typeof outside>();
      for (const w of outside) {
        const f = model.rooms.find((r) => r.id === w.roomId)!.floor;
        (byFloor.get(f) ?? byFloor.set(f, []).get(f)!).push(w);
      }
      for (const [f, ws] of byFloor) {
        const g = quadsGeometry(ws, true);
        floorGroups[f].add(new THREE.Mesh(g, mat));
        disposables.push(g);
      }
      disposables.push(mat);
    }

    // Stairs get no geometry of their own: the photos already show the real ones, and drawn
    // steps fought with them. The flight path still climbs them (see buildFlightPath).

    // Depth meshes: near a photo's viewpoint, its own depth mesh takes over from the flat
    // projection. From the viewpoint both show the same pixels; stepping or looking around
    // (and in stereo) the furniture then has real depth instead of being painted on the walls.
    const shotById = new Map(model.rooms.flatMap((r) => r.photos.map((p) => [p.photoId, { p, floor: r.floor }] as const)));
    const depthMeshes: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; x: number; z: number; yaw: number }[] = [];
    for (const l of depthLayers) {
      const shot = shotById.get(l.photoId);
      if (!shot || !photos.has(l.photoId)) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(l.positions, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(l.uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(l.indices, 1));
      // Dithered transparency: no sorting trouble while it fades in and out.
      const mat = new THREE.MeshBasicMaterial({ map: photoTexture(l.photoId), side: THREE.DoubleSide, alphaHash: true, opacity: 0 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(shot.p.x, shot.p.y, shot.p.z);
      mesh.rotation.y = shot.p.yaw;
      mesh.visible = false;
      floorGroups[shot.floor].add(mesh);
      depthMeshes.push({ mesh, mat, x: shot.p.x, z: shot.p.z, yaw: shot.p.yaw });
      disposables.push(geo, mat);
    }
    const fwd = new THREE.Vector3();
    const fadeDepth = (cam: THREE.Vector3) => {
      camera.getWorldDirection(fwd);
      const camYaw = Math.atan2(-fwd.x, -fwd.z);
      for (const d of depthMeshes) {
        const dist = Math.hypot(cam.x - d.x, cam.z - d.z);
        const turn = Math.abs(Math.atan2(Math.sin(camYaw - d.yaw), Math.cos(camYaw - d.yaw)));
        const a = (1 - THREE.MathUtils.smoothstep(dist, 0.35, 1.5)) * (1 - THREE.MathUtils.smoothstep(turn, 0.9, 1.6));
        d.mat.opacity = a;
        d.mesh.visible = a > 0.02;
      }
    };

    // Camera rig: the path moves the rig; look-around (drag / tilt / headset) turns the camera inside it.
    const rig = new THREE.Group();
    scene.add(rig);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 400);
    camera.rotation.order = "YXZ";
    rig.add(camera);
    const stereo = new THREE.StereoCamera();
    const view = new THREE.PerspectiveCamera(60, 1, 0.05, 400);

    // Look-around state.
    const look = { yaw: 0, pitch: 0 };
    const target = { yaw: 0, pitch: 0 };
    let dragging: { x: number; y: number; yaw: number; pitch: number } | null = null;
    let tapStart: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => {
      e.stopPropagation();
      dragging = { x: e.clientX, y: e.clientY, yaw: target.yaw, pitch: target.pitch };
      tapStart = { x: e.clientX, y: e.clientY, t: performance.now() };
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const w = host.clientWidth || 1;
      target.yaw = dragging.yaw + ((e.clientX - dragging.x) / w) * 3.2;
      target.pitch = Math.max(-1.2, Math.min(1.2, dragging.pitch + ((e.clientY - dragging.y) / w) * 2.4));
    };
    const onUp = (e: PointerEvent) => {
      e.stopPropagation();
      dragging = null;
      const s = tapStart;
      tapStart = null;
      if (e.type === "pointerup" && s && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 10 && performance.now() - s.t < 500) live.current.onTap?.();
    };
    const onWheel = (e: WheelEvent) => {
      target.yaw += e.deltaX * 0.003;
      target.pitch = Math.max(-1.2, Math.min(1.2, target.pitch + e.deltaY * 0.002));
    };
    const el = renderer.domElement;
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: true });

    // Tilt to look: the phone's orientation relative to how it was held when tilt was turned on.
    const gyroQ = new THREE.Quaternion();
    let gyroBase: THREE.Quaternion | null = null;
    const devQ = (alpha: number, beta: number, gamma: number, orient: number) => {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(beta, alpha, -gamma, "YXZ"));
      q.multiply(new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2)); // camera looks out the back of the device
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -orient));
      return q;
    };
    const onOrient = (e: DeviceOrientationEvent) => {
      if (!live.current.gyro || e.alpha == null || e.beta == null || e.gamma == null) return;
      const d = Math.PI / 180;
      const q = devQ(e.alpha * d, e.beta * d, e.gamma * d, (screen.orientation?.angle ?? 0) * d);
      gyroBase ??= q.clone();
      gyroQ.copy(gyroBase).invert().multiply(q);
    };
    window.addEventListener("deviceorientation", onOrient);

    let width = 0, height = 0;
    const resize = () => {
      width = host.clientWidth;
      height = host.clientHeight;
      if (!renderer.xr.isPresenting) renderer.setSize(width, height, false);
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // WebXR (headsets): offered to the page, which shows an "Enter VR" button.
    const xr = (navigator as Navigator & { xr?: { isSessionSupported(m: string): Promise<boolean>; requestSession(m: string, o?: object): Promise<XRSession> } }).xr;
    if (xr && live.current.onXr) {
      xr.isSessionSupported("immersive-vr")
        .then((ok) =>
          live.current.onXr?.(
            ok
              ? async () => {
                  const session = await xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
                  renderer.xr.setReferenceSpaceType("local");
                  await renderer.xr.setSession(session);
                }
              : null,
          ),
        )
        .catch(() => live.current.onXr?.(null));
    } else live.current.onXr?.(null);

    let t = clockRef.current.t;
    let lastSeek = clockRef.current.seekN;
    let lastRecenter = live.current.recenter;
    let lastReport = 0;
    let ended = false;
    let frame = 0;
    const clock = new THREE.Clock();
    const camWorld = new THREE.Vector3();
    const tick = () => {
      const dt = Math.min(0.05, clock.getDelta());
      frame++;
      const p = live.current;
      if (p.seek.n !== lastSeek) {
        lastSeek = clockRef.current.seekN = p.seek.n;
        t = Math.max(0, Math.min(path.duration, p.seek.t));
        ended = false;
      }
      if (p.recenter !== lastRecenter) {
        lastRecenter = p.recenter;
        target.yaw = target.pitch = 0;
        gyroBase = null;
        gyroQ.identity();
      }
      if (p.playing && !ended) {
        t += dt * p.speed;
        if (t >= path.duration) {
          t = path.duration;
          ended = true;
          p.onEnd();
        }
      }
      clockRef.current.t = t;
      const s = sampleAt(path, t);
      const k = 1 - Math.exp(-dt * 12);
      look.yaw += (target.yaw - look.yaw) * k;
      look.pitch += (target.pitch - look.pitch) * k;

      if (s) {
        rig.position.set(s.x, s.y, s.z);
        const floorElev = model.floors[s.floor]?.elevation ?? 0;
        floorGroups.forEach((g, i) => (g.visible = model.floors[i].elevation <= floorElev + 0.1));
        if (renderer.xr.isPresenting) {
          // The headset does the looking; the rig only carries you along (turning with the path).
          rig.rotation.set(0, s.yaw + look.yaw, 0);
          camera.rotation.set(0, 0, 0);
        } else {
          rig.rotation.set(0, s.yaw + look.yaw, 0);
          camera.quaternion.setFromEuler(new THREE.Euler(s.pitch + look.pitch, 0, 0, "YXZ"));
          if (p.gyro) camera.quaternion.multiply(gyroQ);
        }
      }
      camera.updateMatrixWorld(true);
      camera.getWorldPosition(camWorld);
      for (const u of updaters) u(camWorld);
      fadeDepth(camWorld);

      if (performance.now() - lastReport > 120) {
        lastReport = performance.now();
        p.onState({ t, roomId: s?.roomId ?? null, photoId: s?.photoId ?? null });
      }

      if (renderer.xr.isPresenting) {
        renderer.render(scene, camera);
        return;
      }

      renderer.setScissorTest(true);
      renderer.setViewport(0, 0, width, height);
      renderer.setScissor(0, 0, width, height);
      renderer.setClearColor(sky);
      renderer.clear();

      // Build a world-space camera to render from (the rig's child camera, flattened).
      view.position.copy(camWorld);
      camera.getWorldQuaternion(view.quaternion);
      const eyes: { cam: THREE.Camera; x: number; w: number }[] = [];
      const layout = p.layout;
      const sbs = layout === "cross" || layout === "parallel";
      const total = sbs ? width * Math.min(1, Math.max(0.3, p.pairWidth)) : width;
      const eyeW = sbs ? total / 2 : width;
      const aspect = eyeW / Math.max(1, height);
      view.aspect = aspect;
      view.fov = (2 * Math.atan(Math.tan((HFOV * Math.PI) / 360) / Math.max(0.6, aspect)) * 180) / Math.PI;
      view.fov = Math.min(100, view.fov);
      view.updateProjectionMatrix();
      view.updateMatrixWorld(true);
      // Converge a few metres ahead: comfortable for rooms.
      view.focus = 3;
      if (layout === "mono" || layout === "wiggle") {
        let cam: THREE.Camera = view;
        if (layout === "wiggle") {
          stereo.eyeSep = EYE_SEP * p.strength * 1.5;
          stereo.update(view);
          cam = Math.floor(frame / 8) % 2 ? stereo.cameraL : stereo.cameraR;
        }
        eyes.push({ cam, x: 0, w: width });
      } else {
        stereo.eyeSep = EYE_SEP * p.strength;
        stereo.aspect = 1;
        stereo.update(view);
        const [first, second] = layout === "cross" ? [stereo.cameraR, stereo.cameraL] : [stereo.cameraL, stereo.cameraR];
        const left = (width - total) / 2;
        eyes.push({ cam: first, x: left, w: eyeW }, { cam: second, x: left + eyeW, w: eyeW });
      }
      const guides: string[] = [];
      for (const eye of eyes) {
        renderer.setViewport(eye.x, 0, eye.w, height);
        renderer.setScissor(eye.x, 0, eye.w, height);
        renderer.clear();
        renderer.render(scene, eye.cam);
        guides.push(`${eye.x + eye.w / 2}px`);
      }
      if (guideRef.current) {
        const dots = guideRef.current.children;
        for (let i = 0; i < dots.length; i++) {
          const d = dots[i] as HTMLElement;
          d.style.display = eyes.length > 1 ? "block" : "none";
          if (guides[i]) d.style.left = guides[i];
        }
      }
    };
    renderer.setAnimationLoop(tick);

    return () => {
      renderer.setAnimationLoop(null);
      void renderer.xr.getSession()?.end().catch(() => {});
      ro.disconnect();
      window.removeEventListener("deviceorientation", onOrient);
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      el.remove();
    };
  }, [model, path, photos, wallArt, palette, depthLayers]);

  return (
    <div ref={hostRef} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <div ref={guideRef} style={{ position: "absolute", left: 0, right: 0, top: 8, height: 0, pointerEvents: "none" }}>
        {[0, 1].map((i) => (
          <span key={i} style={{ position: "absolute", width: 8, height: 8, marginLeft: -4, borderRadius: 8, background: "#fff", opacity: 0.85 }} />
        ))}
      </div>
    </div>
  );
}

type Quad = { ax: number; az: number; bx: number; bz: number; y0: number; y1: number; u0: number; u1: number; v0: number; v1: number; side: string };

/** Wall quads → triangles facing into the room (or out, for outside faces). */
function quadsGeometry(quads: Quad[], outside = false): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const q of quads) {
    const A0 = [q.ax, q.y0, q.az], B0 = [q.bx, q.y0, q.bz], B1 = [q.bx, q.y1, q.bz], A1 = [q.ax, q.y1, q.az];
    // Seen from inside, A is on the left: A0 B0 B1 is counter-clockwise, i.e. front-facing.
    const tri = outside ? [A0, B1, B0, A0, A1, B1] : [A0, B0, B1, A0, B1, A1];
    for (const v of tri) pos.push(...v);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const STRIP = Object.fromEntries(SIDES.map((s, i) => [s, i])) as Record<string, number>;

/**
 * One room: walls, floor and ceiling in one mesh, with a shader that projects
 * up to MAX_PHOTOS listing photos from their cameras and falls back to the
 * wall art / paint colours where no photo reaches.
 */
function roomMesh(
  room: HouseRoom,
  quads: Quad[],
  colors: RoomColors,
  art: THREE.Texture | null,
  withFloor: boolean,
  photoTexture: (id: string) => THREE.Texture,
  photos: Map<string, ListingImage>,
  disposables: { dispose(): void }[],
) {
  const pos: number[] = [], uv: number[] = [], kind: number[] = [];
  const push = (v: number[], u: [number, number], k: number) => {
    pos.push(...v);
    uv.push(...u);
    kind.push(k);
  };
  for (const q of quads) {
    const strip = STRIP[q.side] ?? 0;
    // Strip i fills rows i/4..(i+1)/4 from the top of the art; texture v runs bottom-up. Trim a sliver off every edge.
    const vLo = 1 - (strip + 1) / 4 + 0.012, vHi = 1 - strip / 4 - 0.012;
    const U = (u: number) => 0.01 + u * 0.98;
    const V = (v: number) => vLo + v * (vHi - vLo);
    const A0 = [q.ax, q.y0, q.az], B0 = [q.bx, q.y0, q.bz], B1 = [q.bx, q.y1, q.bz], A1 = [q.ax, q.y1, q.az];
    const a0: [number, number] = [U(q.u0), V(q.v0)], b0: [number, number] = [U(q.u1), V(q.v0)], b1: [number, number] = [U(q.u1), V(q.v1)], a1: [number, number] = [U(q.u0), V(q.v1)];
    push(A0, a0, 0); push(B0, b0, 0); push(B1, b1, 0);
    push(A0, a0, 0); push(B1, b1, 0); push(A1, a1, 0);
  }
  const { x0, x1, z0, z1 } = room.box;
  const fy = room.elevation + 0.002, cy = room.elevation + WALL_H;
  if (withFloor) {
    // Faces up: counter-clockwise seen from above.
    push([x0, fy, z0], [0, 0], 1); push([x0, fy, z1], [0, 0], 1); push([x1, fy, z1], [0, 0], 1);
    push([x0, fy, z0], [0, 0], 1); push([x1, fy, z1], [0, 0], 1); push([x1, fy, z0], [0, 0], 1);
  }
  // Ceiling faces down, so it vanishes when seen from above (the dollhouse view).
  push([x0, cy, z0], [0, 0], 2); push([x1, cy, z1], [0, 0], 2); push([x0, cy, z1], [0, 0], 2);
  push([x0, cy, z0], [0, 0], 2); push([x1, cy, z0], [0, 0], 2); push([x1, cy, z1], [0, 0], 2);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("kind", new THREE.Float32BufferAttribute(kind, 1));

  // Projectors: the photos with the most different headings, if there are more than fit.
  const shots = room.photos.slice(0, MAX_PHOTOS).filter((p) => photos.has(p.photoId));
  const projMats: THREE.Matrix4[] = [], projPos: THREE.Vector3[] = [];
  const cam = new THREE.PerspectiveCamera();
  for (const s of shots) {
    const img = photos.get(s.photoId)!;
    const aspect = img.width / img.height;
    cam.fov = (2 * Math.atan(Math.tan((DEFAULT_INTRINSICS.hfovDeg * Math.PI) / 360) / aspect) * 180) / Math.PI;
    cam.aspect = aspect;
    cam.near = 0.05;
    cam.far = 100;
    cam.position.set(s.x, s.y, s.z);
    cam.rotation.set(0, s.yaw, 0, "YXZ");
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    projMats.push(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    projPos.push(new THREE.Vector3(s.x, s.y, s.z));
  }
  while (projMats.length < MAX_PHOTOS) {
    projMats.push(new THREE.Matrix4());
    projPos.push(new THREE.Vector3());
  }
  const blank = new THREE.Texture();
  disposables.push(blank);
  const uniforms: Record<string, THREE.IUniform> = {
    art: { value: art ?? blank },
    hasArt: { value: art ? 1 : 0 },
    wallColor: { value: new THREE.Color(colors.wall) },
    floorColor: { value: new THREE.Color(colors.floor) },
    ceilColor: { value: new THREE.Color(colors.ceiling) },
    count: { value: shots.length },
    projM: { value: projMats },
    projP: { value: projPos },
    camPos: { value: new THREE.Vector3() },
    elev: { value: room.elevation },
  };
  for (let i = 0; i < MAX_PHOTOS; i++) uniforms[`ph${i}`] = { value: shots[i] ? photoTexture(shots[i].photoId) : blank };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute float kind;
      varying vec3 vW;
      varying vec2 vUv;
      varying float vKind;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vUv = uv;
        vKind = kind;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D art;
      uniform float hasArt;
      uniform vec3 wallColor, floorColor, ceilColor;
      uniform int count;
      uniform mat4 projM[${MAX_PHOTOS}];
      uniform vec3 projP[${MAX_PHOTOS}];
      uniform vec3 camPos;
      uniform float elev;
      ${Array.from({ length: MAX_PHOTOS }, (_, i) => `uniform sampler2D ph${i};`).join("\n")}
      varying vec3 vW;
      varying vec2 vUv;
      varying float vKind;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

      // One photo's contribution: its colour × weight (rgb) and the weight (a).
      vec4 project(sampler2D t, mat4 m, vec3 p, inout float maxW) {
        vec4 c = m * vec4(vW, 1.0);
        if (c.w <= 0.0) return vec4(0.0);
        vec2 n = c.xy / c.w;
        if (abs(n.x) > 1.0 || abs(n.y) > 1.0) return vec4(0.0);
        float edge = smoothstep(0.0, 0.1, 1.0 - abs(n.x)) * smoothstep(0.0, 0.1, 1.0 - abs(n.y));
        // Prefer photos taken near where you are, looking the way you look at this spot.
        float d = distance(camPos, p);
        float near = 0.25 + 0.75 * exp(-d * d / 2.5);
        float ang = max(0.0, dot(normalize(vW - p), normalize(vW - camPos)));
        float w = edge * near * (0.3 + 0.7 * ang * ang * ang);
        maxW = max(maxW, w);
        // Sharpened for the blend, so the best-placed photo wins instead of several ghosting together.
        float s = w * w * w * w + 1e-6;
        return vec4(texture2D(t, n * 0.5 + 0.5).rgb * s, s) * step(1e-4, w);
      }

      void main() {
        vec3 base;
        if (vKind < 0.5) {
          base = hasArt > 0.5 ? texture2D(art, vUv).rgb : wallColor;
          if (hasArt < 0.5) {
            // Plain paint: a soft darkening towards floor and ceiling, like bounce light.
            float h = clamp((vW.y - elev) / ${WALL_H.toFixed(2)}, 0.0, 1.0);
            base *= 0.86 + 0.14 * smoothstep(0.0, 0.25, h) * smoothstep(1.0, 0.8, h);
          }
        } else if (vKind < 1.5) {
          float n = hash(floor(vW.xz * 8.0)) * 0.06 - 0.03;
          base = floorColor * (1.0 + n);
        } else {
          base = ceilColor;
        }
        vec4 acc = vec4(0.0);
        float maxW = 0.0;
        ${Array.from({ length: MAX_PHOTOS }, (_, i) => `if (count > ${i}) acc += project(ph${i}, projM[${i}], projP[${i}], maxW);`).join("\n        ")}
        vec3 col = base;
        if (acc.a > 0.0) col = mix(base, acc.rgb / acc.a, clamp(maxW * 3.0, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  disposables.push(geo, mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return {
    mesh,
    update: (camWorld: THREE.Vector3) => (uniforms.camPos.value as THREE.Vector3).copy(camWorld),
  };
}
