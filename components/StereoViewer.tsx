"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { DEFAULT_INTRINSICS, gridIndices } from "@/lib/geometry";
import type { RoomModel } from "@/lib/client/room-model";

export type StereoLayout = "cross" | "parallel" | "wiggle" | "mono";

export interface NavTarget {
  id: string;
  label: string;
  rel: number;
  dim?: boolean;
}

interface Props {
  model: RoomModel;
  layout: StereoLayout;
  /** Multiplier on a 64 mm eye separation. ~1 is natural; more exaggerates depth. */
  strength: number;
  /**
   * Side-by-side only: share of the screen width the pair may use (0.3–1).
   * A phone in landscape is wider than eyes are apart; squeezing the pair
   * towards the middle makes it fusable.
   */
  pairWidth?: number;
  /** Neighbouring rooms to show as 3D floor arrows: `rel` = degrees from the active photo's facing, clockwise. */
  nav?: NavTarget[];
  showNav?: boolean;
  onNavigate?: (roomId: string) => void;
  /** A tap (not a drag) that didn't hit an arrow. */
  onTap?: () => void;
  /** A long sideways drag: +1 = turn right (clockwise), −1 = turn left. The page picks the next viewpoint. */
  onSwipe?: (dir: 1 | -1) => void;
  activeLayer: number;
  gyro: boolean;
  /** Set when navigating away: dolly the camera forward ("walking" out). */
  exiting?: boolean;
  className?: string;
}

const EYE_SEP = 0.064;
const MAX_PARALLAX = 0.12; // metres of simulated head movement at full tilt
const YAW_LIMIT = 0.18; // how far a drag turns the view before it lets go (radians)
const SWIPE = 0.18; // share of the view's width a drag must cover to step to the next viewpoint

/**
 * Renders one photo at a time as a stereo pair: a static shot, seen only from
 * where it was taken. The photo is a depth-displaced mesh (a GPU form of
 * depth-image-based rendering): the second eye sees it from a few centimetres
 * to the side, so near things shift more than far ones. The mesh keeps every
 * triangle, so depth edges stretch a little instead of tearing open; there are
 * no holes for anything else to show through. A long sideways drag steps to
 * the next viewpoint (snap, no blend): other photos are never drawn from
 * someone else's viewpoint, where imperfect poses and depth smear them.
 */
export default function StereoViewer({
  model,
  layout,
  strength,
  pairWidth = 1,
  nav,
  showNav,
  onNavigate,
  onTap,
  onSwipe,
  activeLayer,
  gyro,
  exiting,
  className,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const live = useRef({ layout, strength, pairWidth, activeLayer, gyro, exiting: !!exiting, nav, showNav, onNavigate, onTap, onSwipe });
  useEffect(() => {
    live.current = { layout, strength, pairWidth, activeLayer, gyro, exiting: !!exiting, nav, showNav, onNavigate, onTap, onSwipe };
  });

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor("#0b0c0f");
    // Two passes per eye (see tick), so clearing is manual.
    renderer.autoClear = false;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";

    const scene = new THREE.Scene();
    const disposables: { dispose(): void }[] = [];
    const loader = new THREE.TextureLoader();

    // Every photo's mesh up front, so a snap never shows one whose texture is still loading (black).
    const meshes = model.layers.map((layer) => {
      const tex = loader.load(layer.photo.dataUrl);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(layer.positions, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(layer.uvs, 2));
      // Every triangle, depth edges included (the layer's own indices drop those; see gridIndices).
      geo.setIndex(new THREE.BufferAttribute(gridIndices(layer.positions, layer.cols, layer.rows, Infinity), 1));
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      const g = new THREE.Group();
      g.add(mesh);
      g.rotation.y = layer.pose.yaw;
      g.position.set(layer.pose.tx, 0, layer.pose.tz);
      g.scale.setScalar(layer.pose.scale);
      scene.add(g);
      disposables.push(tex, geo, mat);
      return mesh;
    });

    const photo = model.layers[0]?.photo;
    const photoAspect = photo ? photo.width / photo.height : 4 / 3;
    const hfov = (DEFAULT_INTRINSICS.hfovDeg * Math.PI) / 180;
    const vfovDeg = (2 * Math.atan(Math.tan(hfov / 2) / photoAspect) * 180) / Math.PI;
    const camera = new THREE.PerspectiveCamera(vfovDeg, photoAspect, 0.05, 100);
    camera.rotation.order = "YXZ";
    const stereo = new THREE.StereoCamera();
    stereo.aspect = 1; // we keep photo aspect per eye ourselves

    // Navigation arrows: Street View-style chevrons on the floor a couple of
    // metres ahead, pointing towards each neighbouring room. They live in the
    // scene, so each eye sees them from its own position and they appear in
    // depth; a second render pass draws them over the photo. Rooms off to the
    // side or behind are pinned to the edge of the view, still pointing their
    // true way.
    const navGroup = new THREE.Group();
    scene.add(navGroup);
    const raycaster = new THREE.Raycaster();
    let lastEyes: { cam: THREE.Camera; x: number; y: number; w: number; h: number }[] = [];
    let navKey = "";
    const chevron = (() => {
      const sh = new THREE.Shape();
      sh.moveTo(0, 0.3);
      sh.lineTo(0.28, -0.05);
      sh.lineTo(0.17, -0.14);
      sh.lineTo(0, 0.07);
      sh.lineTo(-0.17, -0.14);
      sh.lineTo(-0.28, -0.05);
      sh.closePath();
      const g = new THREE.ShapeGeometry(sh);
      g.rotateX(-Math.PI / 2); // lie flat, pointing forward (−Z)
      return g;
    })();
    const hitDisc = new THREE.CircleGeometry(0.4, 20).rotateX(-Math.PI / 2);
    disposables.push(chevron, hitDisc);
    const navDisposables: { dispose(): void }[] = [];
    const buildNav = (targets: NavTarget[]) => {
      navDisposables.splice(0).forEach((d) => d.dispose());
      navGroup.clear();
      // Where each arrow sits: its true direction clamped into the view, spread apart so none overlap.
      const HALF = 24; // degrees either side of straight ahead (the photo spans ±37.5° across, ±30° down)
      const placed = [...targets]
        .sort((a, b) => a.rel - b.rel)
        .map((t) => ({ t, at: Math.max(-HALF, Math.min(HALF, t.rel)) }));
      for (let i = 1; i < placed.length; i++) placed[i].at = Math.max(placed[i].at, placed[i - 1].at + 13);
      const over = placed.length ? placed[placed.length - 1].at - HALF : 0;
      if (over > 0) placed.forEach((p) => (p.at -= over));
      for (const { t, at } of placed) {
        const a = (at * Math.PI) / 180;
        const behind = Math.min(1, Math.max(0, (Math.abs(t.rel) - HALF) / 90));
        // ~15° below the horizon ahead, a little lower and nearer for rooms behind.
        const d = 2.6 - 0.4 * behind;
        const y = -0.7 - 0.12 * behind;
        const item = new THREE.Group();
        item.position.set(Math.sin(a) * d, y, -Math.cos(a) * d);
        const mat = new THREE.MeshBasicMaterial({
          color: t.dim ? "#c9ced6" : "#ffffff",
          transparent: true,
          opacity: t.dim ? 0.6 : 0.95,
          depthTest: false,
          side: THREE.DoubleSide,
        });
        const arrow = new THREE.Mesh(chevron, mat);
        arrow.scale.setScalar(1.3);
        arrow.rotation.y = (-t.rel * Math.PI) / 180;
        arrow.userData.navId = t.id;
        const hit = new THREE.Mesh(hitDisc, new THREE.MeshBasicMaterial({ visible: false }));
        hit.userData.navId = t.id;
        // Room name, floating just above the arrow.
        const c = document.createElement("canvas");
        c.width = 512;
        c.height = 96;
        const g = c.getContext("2d")!;
        g.font = "600 52px system-ui, sans-serif";
        const w = Math.min(500, g.measureText(t.label).width + 48);
        g.fillStyle = "rgba(14,16,20,0.72)";
        g.beginPath();
        g.roundRect((512 - w) / 2, 8, w, 80, 40);
        g.fill();
        g.fillStyle = t.dim ? "#c9ced6" : "#ffffff";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(t.label, 256, 50);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        const spriteMat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
        const label = new THREE.Sprite(spriteMat);
        label.scale.set(1.1, 0.21, 1);
        label.position.set(0, 0.3, 0);
        label.userData.navId = t.id;
        item.add(arrow, hit, label);
        item.traverse((o) => o.layers.set(2));
        navGroup.add(item);
        navDisposables.push(mat, hit.material as THREE.Material, tex, spriteMat);
      }
    };
    disposables.push({ dispose: () => navDisposables.splice(0).forEach((d) => d.dispose()) });

    // Look-around state: drag (or mouse move) + gyro, both smoothed.
    const look = { yaw: 0, pitch: 0, tx: 0, ty: 0 };
    const target = { yaw: 0, pitch: 0, tx: 0, ty: 0 };
    let dolly = 0;
    let dragging: { x: number; y: number; yaw: number; pitch: number } | null = null;
    let shownLayer = -1;
    const clamp = (v: number, l: number) => Math.max(-l, Math.min(l, v));

    let tapStart: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => {
      e.stopPropagation(); // taps are handled here, not by the page around the viewer
      dragging = { x: e.clientX, y: e.clientY, yaw: target.yaw, pitch: target.pitch };
      tapStart = { x: e.clientX, y: e.clientY, t: performance.now() };
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const w = host.clientWidth || 1;
      if (dragging) {
        target.yaw = clamp(dragging.yaw + ((e.clientX - dragging.x) / w) * 0.6, YAW_LIMIT);
        target.pitch = clamp(dragging.pitch + ((e.clientY - dragging.y) / w) * 0.6, 0.25);
      } else if (e.pointerType === "mouse" && !live.current.gyro) {
        // Desktop stand-in for head movement: hover position → small parallax.
        const r = host.getBoundingClientRect();
        target.tx = (((e.clientX - r.left) / r.width) * 2 - 1) * MAX_PARALLAX;
        target.ty = -(((e.clientY - r.top) / r.height) * 2 - 1) * MAX_PARALLAX * 0.6;
      }
    };
    const onUp = (e: PointerEvent) => {
      e.stopPropagation();
      const d = dragging;
      dragging = null;
      const s = tapStart;
      tapStart = null;
      // A long sideways drag steps to the next viewpoint. Dragging left turns right, as when looking around.
      const dx = e.clientX - (d?.x ?? e.clientX), dy = e.clientY - (d?.y ?? e.clientY);
      if (e.type === "pointerup" && live.current.onSwipe && model.layers.length > 1 && Math.abs(dx) > (host.clientWidth || 1) * SWIPE && Math.abs(dx) > 2 * Math.abs(dy)) {
        live.current.onSwipe(dx < 0 ? 1 : -1);
        return;
      }
      if (e.type !== "pointerup" || !s || Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10 || performance.now() - s.t > 500) return;
      // A tap: did it land on a floor arrow, in either eye's image?
      if (live.current.showNav) {
        const rect = renderer.domElement.getBoundingClientRect();
        const px = e.clientX - rect.left, py = rect.height - (e.clientY - rect.top);
        for (const eye of lastEyes) {
          if (px < eye.x || px > eye.x + eye.w || py < eye.y || py > eye.y + eye.h) continue;
          const ndc = new THREE.Vector2(((px - eye.x) / eye.w) * 2 - 1, ((py - eye.y) / eye.h) * 2 - 1);
          raycaster.layers.set(2);
          // StereoCamera sets its eye cameras' projection but not the inverse the raycaster unprojects with.
          const cam = eye.cam as THREE.PerspectiveCamera;
          cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
          raycaster.setFromCamera(ndc, cam);
          const hit = raycaster.intersectObjects(navGroup.children, true).find((h) => h.object.userData.navId);
          if (hit) return live.current.onNavigate?.(hit.object.userData.navId);
        }
      }
      live.current.onTap?.();
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("pointercancel", onUp);

    let baseline: { beta: number; gamma: number } | null = null;
    const onOrient = (e: DeviceOrientationEvent) => {
      if (!live.current.gyro || e.beta == null || e.gamma == null) return;
      // Map to screen axes regardless of device rotation.
      const angle = (screen.orientation?.angle ?? 0) % 360;
      let x = e.gamma, y = e.beta;
      if (angle === 90) [x, y] = [e.beta, -e.gamma];
      else if (angle === 270 || angle === -90) [x, y] = [-e.beta, e.gamma];
      else if (angle === 180) [x, y] = [-e.gamma, -e.beta];
      baseline ??= { beta: y, gamma: x };
      // Let the baseline drift slowly so the view recentres when the user settles.
      baseline.beta += (y - baseline.beta) * 0.01;
      baseline.gamma += (x - baseline.gamma) * 0.01;
      const dx = clamp((x - baseline.gamma) / 20, 1);
      const dy = clamp((y - baseline.beta) / 20, 1);
      target.tx = dx * MAX_PARALLAX;
      target.ty = -dy * MAX_PARALLAX * 0.6;
    };
    window.addEventListener("deviceorientation", onOrient);

    let width = 0, height = 0;
    const resize = () => {
      width = host.clientWidth;
      height = host.clientHeight;
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = `${width}px`;
      renderer.domElement.style.height = `${height}px`;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    /** Largest photo-aspect rect that fits in (w,h), centred at (cx, cy). */
    const fit = (w: number, h: number) => {
      const a = photoAspect;
      return w / h > a ? { w: h * a, h } : { w, h: w / a };
    };

    let frame = 0;
    let raf = 0;
    const clock = new THREE.Clock();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, clock.getDelta());
      frame++;
      const { layout, strength, pairWidth, activeLayer, exiting } = live.current;
      const k = 1 - Math.exp(-dt * 10);
      for (const key of ["yaw", "pitch", "tx", "ty"] as const) look[key] += (target[key] - look[key]) * k;
      dolly += ((exiting ? 0.7 : 0) - dolly) * (1 - Math.exp(-dt * 6));

      const idx = Math.min(activeLayer, model.layers.length - 1);
      const layer = model.layers[idx];
      if (!layer) return;
      if (idx !== shownLayer) {
        // Snap: the new photo opens straight ahead, as it was taken.
        shownLayer = idx;
        look.yaw = look.pitch = target.yaw = target.pitch = 0;
        dragging = null;
      }
      meshes.forEach((m, i) => (m.parent!.visible = i === idx));

      // Camera sits where the active photo was taken, looking the same way.
      const p = layer.pose;
      camera.rotation.set(look.pitch, p.yaw + look.yaw, 0);
      const fwd = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation);
      const right = new THREE.Vector3(1, 0, 0).applyEuler(camera.rotation);
      camera.position
        .set(p.tx, 0, p.tz)
        .addScaledVector(right, look.tx * p.scale)
        .addScaledVector(new THREE.Vector3(0, 1, 0), look.ty * p.scale)
        .addScaledVector(fwd, dolly * p.scale);
      camera.focus = layer.focus * p.scale;
      camera.updateMatrixWorld();

      const { nav, showNav } = live.current;
      const key = showNav && nav ? JSON.stringify(nav) : "";
      if (key !== navKey) {
        navKey = key;
        buildNav(key ? nav! : []);
      }
      // Anchored to where the active photo was taken (not to the look-around), so they stay put in the room.
      navGroup.position.set(p.tx, 0, p.tz);
      navGroup.rotation.set(0, p.yaw, 0);
      navGroup.scale.setScalar(p.scale);

      renderer.setScissorTest(true);
      renderer.setViewport(0, 0, width, height);
      renderer.setScissor(0, 0, width, height);
      renderer.clear();

      const eyes: { cam: THREE.Camera; x: number; w: number }[] = [];
      if (layout === "mono" || layout === "wiggle") {
        let cam: THREE.Camera = camera;
        if (layout === "wiggle") {
          stereo.eyeSep = EYE_SEP * strength * 1.5 * p.scale;
          stereo.update(camera);
          cam = Math.floor(frame / 8) % 2 ? stereo.cameraL : stereo.cameraR;
        }
        eyes.push({ cam, x: 0, w: width });
      } else {
        stereo.eyeSep = EYE_SEP * strength * p.scale;
        stereo.update(camera);
        // Cross-eyed viewing: the LEFT image is what the RIGHT eye sees.
        const [first, second] = layout === "cross" ? [stereo.cameraR, stereo.cameraL] : [stereo.cameraL, stereo.cameraR];
        const total = width * Math.min(1, Math.max(0.3, pairWidth));
        const left = (width - total) / 2;
        eyes.push({ cam: first, x: left, w: total / 2 }, { cam: second, x: left + total / 2, w: total / 2 });
      }

      const guides: string[] = [];
      lastEyes = [];
      for (const [i, eye] of eyes.entries()) {
        const r = fit(eye.w - (eyes.length > 1 ? 4 : 0), height);
        // Pull the pair towards the centre line: easier to fuse.
        const x = eyes.length > 1 ? (i === 0 ? eye.x + eye.w - r.w - 2 : eye.x + 2) : eye.x + (eye.w - r.w) / 2;
        const y = (height - r.h) / 2;
        renderer.setViewport(x, y, r.w, r.h);
        renderer.setScissor(x, y, r.w, r.h);
        renderer.clear();
        eye.cam.layers.set(0);
        renderer.render(scene, eye.cam);
        if (navGroup.children.length) {
          eye.cam.layers.set(2);
          renderer.render(scene, eye.cam);
        }
        lastEyes.push({ cam: eye.cam, x, y, w: r.w, h: r.h });
        guides.push(`${x + r.w / 2}px`);
      }
      if (guideRef.current) {
        const dots = guideRef.current.children;
        for (let i = 0; i < dots.length; i++) {
          const el = dots[i] as HTMLElement;
          el.style.display = eyes.length > 1 ? "block" : "none";
          if (guides[i]) el.style.left = guides[i];
        }
        const r = fit(eyes[0].w, height);
        guideRef.current.style.top = `${Math.max(4, (height - r.h) / 2 - 14)}px`;
      }
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("deviceorientation", onOrient);
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [model]);

  return (
    <div ref={hostRef} className={className} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      {/* Fusion guide: cross your eyes until these two dots become three. */}
      <div ref={guideRef} style={{ position: "absolute", left: 0, right: 0, top: 8, height: 0, pointerEvents: "none" }}>
        {[0, 1].map((i) => (
          <span key={i} style={{ position: "absolute", width: 8, height: 8, marginLeft: -4, borderRadius: 8, background: "#fff", opacity: 0.85 }} />
        ))}
      </div>
    </div>
  );
}
