"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { buildHouseScene, SKY, type RoomColors } from "@/lib/client/house-scene";
import { sampleAt, type FlightPath, type HouseModel } from "@/lib/house-model";
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

export type { RoomColors };

const EYE_SEP = 0.064;
/** How far from a photo's viewpoint (m) its depth mesh stays up. Farther off, its stretched edges and holes show. */
const DEPTH_MESH_RANGE = 0.6;
const HFOV = 80; // a little wider than the photos, for a sense of space

/**
 * A guided flight through the whole house in 3D (see buildHouseScene for how
 * it's built and painted). The camera follows the flight path; drag, tilt or a
 * VR headset add look-around on top.
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

    const house = buildHouseScene(model, photos, wallArt, palette, renderer);
    const { scene, floorGroups, photoTexture } = house;
    const sky = new THREE.Color(SKY);
    const disposables: { dispose(): void }[] = [house];

    // Stairs get no geometry of their own: the photos already show the real ones, and drawn
    // steps fought with them. The flight path still climbs them (see buildFlightPath).

    // Depth meshes: near a photo's viewpoint, its own depth mesh takes over from the flat
    // projection. From the viewpoint both show the same pixels; stepping or looking around
    // (and in stereo) the furniture then has real depth instead of being painted on the walls.
    // At most one is shown, opaque, and it switches rather than fades: two meshes of nearby
    // photos (or a dithered fade) overlap into a speckled, torn-looking mess.
    const shotById = new Map(model.rooms.flatMap((r) => r.photos.map((p) => [p.photoId, { p, floor: r.floor }] as const)));
    const depthMeshes: { mesh: THREE.Mesh; x: number; z: number; yaw: number }[] = [];
    for (const l of depthLayers) {
      const shot = shotById.get(l.photoId);
      if (!shot || !photos.has(l.photoId)) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(l.positions, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(l.uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(l.indices, 1));
      const mat = new THREE.MeshBasicMaterial({ map: photoTexture(l.photoId), side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(shot.p.x, shot.p.y, shot.p.z);
      mesh.rotation.y = shot.p.yaw;
      mesh.visible = false;
      floorGroups[shot.floor].add(mesh);
      depthMeshes.push({ mesh, x: shot.p.x, z: shot.p.z, yaw: shot.p.yaw });
      disposables.push(geo, mat);
    }
    const fwd = new THREE.Vector3();
    let shownDepth: (typeof depthMeshes)[number] | null = null;
    const pickDepth = (cam: THREE.Vector3) => {
      camera.getWorldDirection(fwd);
      const camYaw = Math.atan2(-fwd.x, -fwd.z);
      // Closest viewpoint you're standing at and roughly facing along; a small bonus for the
      // one already shown, so two photos taken side by side don't flicker back and forth.
      let best: typeof shownDepth = null, bestScore = Infinity;
      for (const d of depthMeshes) {
        const dist = Math.hypot(cam.x - d.x, cam.z - d.z);
        const turn = Math.abs(Math.atan2(Math.sin(camYaw - d.yaw), Math.cos(camYaw - d.yaw)));
        if (dist > DEPTH_MESH_RANGE || turn > 0.8) continue;
        const score = dist + 0.3 * turn - (d === shownDepth ? 0.1 : 0);
        if (score < bestScore) [best, bestScore] = [d, score];
      }
      if (best === shownDepth) return;
      if (shownDepth) shownDepth.mesh.visible = false;
      if (best) best.mesh.visible = true;
      shownDepth = best;
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
      house.update(camWorld);
      pickDepth(camWorld);

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
