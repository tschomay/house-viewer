"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { DEFAULT_INTRINSICS } from "@/lib/geometry";
import type { RoomModel } from "@/lib/client/room-model";

export type StereoLayout = "cross" | "parallel" | "wiggle" | "mono";

interface Props {
  model: RoomModel;
  layout: StereoLayout;
  /** Multiplier on a 64 mm eye separation. ~1 is natural; more exaggerates depth. */
  strength: number;
  activeLayer: number;
  gyro: boolean;
  /** Set when navigating away: dolly the camera forward ("walking" out). */
  exiting?: boolean;
  className?: string;
}

const EYE_SEP = 0.064;
const MAX_PARALLAX = 0.12; // metres of simulated head movement at full tilt

/**
 * Renders a room reconstruction as a stereo pair. Each photo is a depth-displaced
 * mesh (a GPU form of depth-image-based rendering): the second eye sees it from
 * a few centimetres to the side, so near things shift more than far ones.
 * Triangles across depth edges are dropped (see gridIndices); a flat copy of
 * the photo far behind fills the resulting holes.
 */
export default function StereoViewer({ model, layout, strength, activeLayer, gyro, exiting, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const live = useRef({ layout, strength, activeLayer, gyro, exiting: !!exiting });
  useEffect(() => {
    live.current = { layout, strength, activeLayer, gyro, exiting: !!exiting };
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

    const groups = model.layers.map((layer) => {
      const tex = loader.load(layer.photo.dataUrl);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(layer.positions, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(layer.uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(layer.indices, 1));
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);

      // Backdrop: the photo on a plane just past the far wall, dimmed, to fill disocclusion holes.
      const far = DEFAULT_INTRINSICS.far * 1.6;
      const hfov = (DEFAULT_INTRINSICS.hfovDeg * Math.PI) / 180;
      const bw = 2 * far * Math.tan(hfov / 2) * 1.02;
      const bh = (bw * layer.photo.height) / layer.photo.width;
      const backMat = new THREE.MeshBasicMaterial({ map: tex, color: "#9a9a9a", depthWrite: false });
      const back = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), backMat);
      back.position.z = -far;
      back.renderOrder = -1;

      const g = new THREE.Group();
      g.add(back, mesh);
      g.rotation.y = layer.pose.yaw;
      g.position.set(layer.pose.tx, 0, layer.pose.tz);
      g.scale.setScalar(layer.pose.scale);
      scene.add(g);
      disposables.push(tex, geo, mat, backMat, back.geometry);
      return { g, back, mesh };
    });

    const photo = model.layers[0]?.photo;
    const photoAspect = photo ? photo.width / photo.height : 4 / 3;
    const hfov = (DEFAULT_INTRINSICS.hfovDeg * Math.PI) / 180;
    const vfovDeg = (2 * Math.atan(Math.tan(hfov / 2) / photoAspect) * 180) / Math.PI;
    const camera = new THREE.PerspectiveCamera(vfovDeg, photoAspect, 0.05, 100);
    camera.rotation.order = "YXZ";
    const stereo = new THREE.StereoCamera();
    stereo.aspect = 1; // we keep photo aspect per eye ourselves

    // Look-around state: drag (or mouse move) + gyro, both smoothed.
    const look = { yaw: 0, pitch: 0, tx: 0, ty: 0 };
    const target = { yaw: 0, pitch: 0, tx: 0, ty: 0 };
    let dolly = 0;
    let dragging: { x: number; y: number; yaw: number; pitch: number } | null = null;
    const merged = model.mode === "merged";
    const yawLimit = merged ? Math.PI : 0.18;
    const clamp = (v: number, l: number) => Math.max(-l, Math.min(l, v));

    const onDown = (e: PointerEvent) => {
      dragging = { x: e.clientX, y: e.clientY, yaw: target.yaw, pitch: target.pitch };
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const w = host.clientWidth || 1;
      if (dragging) {
        target.yaw = clamp(dragging.yaw + ((e.clientX - dragging.x) / w) * (merged ? 3 : 0.6), yawLimit);
        target.pitch = clamp(dragging.pitch + ((e.clientY - dragging.y) / w) * 0.6, 0.25);
      } else if (e.pointerType === "mouse" && !live.current.gyro) {
        // Desktop stand-in for head movement: hover position → small parallax.
        const r = host.getBoundingClientRect();
        target.tx = (((e.clientX - r.left) / r.width) * 2 - 1) * MAX_PARALLAX;
        target.ty = -(((e.clientY - r.top) / r.height) * 2 - 1) * MAX_PARALLAX * 0.6;
      }
    };
    const onUp = () => (dragging = null);
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
      if (merged) target.yaw = clamp(target.yaw, yawLimit);
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
      const { layout, strength, activeLayer, exiting } = live.current;
      const k = 1 - Math.exp(-dt * 10);
      for (const key of ["yaw", "pitch", "tx", "ty"] as const) look[key] += (target[key] - look[key]) * k;
      dolly += ((exiting ? 0.7 : 0) - dolly) * (1 - Math.exp(-dt * 6));

      const idx = Math.min(activeLayer, model.layers.length - 1);
      const layer = model.layers[idx];
      if (!layer) return;
      // Pass 0: backdrop + the room's other photos. Pass 1: the active photo, drawn over
      // pass 0 so a slightly misplaced neighbour can never cover the current view; the
      // others only show through its holes and when you look beyond its edges.
      groups.forEach(({ g, back, mesh }, i) => {
        g.visible = merged ? model.layers[i].registered || i === idx : i === idx;
        back.visible = i === idx;
        mesh.layers.set(i === idx ? 1 : 0);
      });

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
        eyes.push({ cam: first, x: 0, w: width / 2 }, { cam: second, x: width / 2, w: width / 2 });
      }

      const guides: string[] = [];
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
        renderer.clearDepth();
        eye.cam.layers.set(1);
        renderer.render(scene, eye.cam);
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
