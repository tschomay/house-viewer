"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildHouseScene, type RoomColors } from "@/lib/client/house-scene";
import { WALL_H, type HouseModel } from "@/lib/house-model";
import type { ListingImage, WallArt } from "@/lib/types";

export type DollhouseView = "reset" | "top" | "in" | "out";

interface Props {
  model: HouseModel;
  photos: Map<string, ListingImage>;
  wallArt: Record<string, WallArt>;
  palette: Record<string, RoomColors>;
  /** Index into model.floors of the top floor shown (floors above are hidden), or null for the whole house. */
  floor: number | null;
  /** Wall height as a share of the full height: below 1 cuts the walls down so you can see into rooms. */
  wallCut: number;
  /** Outside walls drawn as siding (a closed building) or left off (see straight into the rooms). */
  siding: boolean;
  labels: boolean;
  autoRotate: boolean;
  /** Room to fly the camera to; `n` changes on every request so the same room can be picked twice. */
  focus: { roomId: string | null; n: number };
  /** A camera move from the buttons; `n` changes on every request. */
  view: { kind: DollhouseView; n: number };
  onPickRoom?: (roomId: string) => void;
  /** Any user drag or zoom (so the page can stop auto-rotate). */
  onInteract?: () => void;
}

const FOV = 45;

/**
 * The house as a dollhouse: an orbiting view from outside, floors above the
 * chosen one lifted off, and (optionally) the walls cut down, so every room is
 * visible at once. Same photo-painted rooms as the fly-through (buildHouseScene).
 * Drag to spin, pinch or scroll to zoom, two fingers or right-drag to pan; tap
 * a room's label (or double-click a room) to fly in to it.
 */
export default function HouseDollhouse(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  useEffect(() => {
    live.current = props;
  });
  const { model, photos, wallArt, palette } = props;

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";

    const house = buildHouseScene(model, photos, wallArt, palette, renderer);
    const { scene, floorGroups, siding } = house;
    // Far enough out that fog doesn't grey the house when zoomed out.
    scene.fog = new THREE.Fog(scene.background as THREE.Color, 120, 320);

    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 600);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false; // pan along the ground, like moving a model on a table
    controls.maxPolarAngle = Math.PI * 0.45; // stay above the ground, looking down a little
    controls.autoRotateSpeed = 0.8;
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    const b = model.bounds;
    const center = new THREE.Vector3((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
    const topElev = Math.max(0, ...model.floors.map((f) => f.elevation));
    const radius = Math.hypot(b.x1 - b.x0, b.z1 - b.z0, topElev + WALL_H) / 2;
    const fitDist = (r: number, aspect: number) => {
      const vfov = (FOV * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
      return r / Math.sin(Math.min(vfov, hfov) / 2);
    };
    controls.minDistance = 1.5;
    controls.maxDistance = fitDist(radius, 1) * 3;

    // The home view: three-quarters from the front door's side, looking down at about 40°.
    const front = model.front ? new THREE.Vector2(model.front.nx, model.front.nz).normalize() : new THREE.Vector2(0, 1);
    const homeDir = new THREE.Vector3(front.x - front.y * 0.6, 0, front.y + front.x * 0.6).normalize();
    homeDir.y = Math.tan((40 * Math.PI) / 180);
    homeDir.normalize();

    // Camera moves ease towards a goal (target + position); a drag cancels them.
    let anim: { t: number; fromT: THREE.Vector3; fromP: THREE.Vector3; toT: THREE.Vector3; toP: THREE.Vector3 } | null = null;
    const moveTo = (target: THREE.Vector3, position: THREE.Vector3, instant = false) => {
      if (instant) {
        controls.target.copy(target);
        camera.position.copy(position);
        controls.update();
        anim = null;
        return;
      }
      anim = { t: 0, fromT: controls.target.clone(), fromP: camera.position.clone(), toT: target.clone(), toP: position.clone() };
    };
    let width = 1, height = 1;
    const floorElev = () => {
      const f = live.current.floor;
      return f == null ? topElev : model.floors[f]?.elevation ?? 0;
    };
    const home = (instant = false) => {
      const t = center.clone().setY(floorElev() + WALL_H * 0.3);
      moveTo(t, t.clone().addScaledVector(homeDir, fitDist(radius, width / height)), instant);
    };
    const topDown = () => {
      const t = center.clone().setY(floorElev());
      // Straight down is a singularity for orbit controls: keep a hair of tilt, towards the front.
      const dir = new THREE.Vector3(front.x * 0.02, 1, front.y * 0.02).normalize();
      moveTo(t, t.clone().addScaledVector(dir, fitDist(Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2, width / height)));
    };
    const zoom = (k: number) => {
      const off = camera.position.clone().sub(controls.target);
      const d = THREE.MathUtils.clamp(off.length() * k, controls.minDistance, controls.maxDistance);
      moveTo(controls.target, controls.target.clone().addScaledVector(off.normalize(), d));
    };
    const focusRoom = (roomId: string) => {
      const r = model.rooms.find((x) => x.id === roomId);
      if (!r) return;
      const t = new THREE.Vector3((r.box.x0 + r.box.x1) / 2, r.elevation + WALL_H * 0.2, (r.box.z0 + r.box.z1) / 2);
      const size = Math.max(3, Math.hypot(r.box.x1 - r.box.x0, r.box.z1 - r.box.z0)) / 2;
      // Keep the current compass direction, but look down steeply enough to see over the walls.
      const off = camera.position.clone().sub(controls.target);
      const flat = Math.hypot(off.x, off.z) || 1;
      const dir = new THREE.Vector3(off.x / flat, Math.tan((55 * Math.PI) / 180), off.z / flat).normalize();
      moveTo(t, t.clone().addScaledVector(dir, fitDist(size * 1.6, width / height)));
    };

    const onStart = () => {
      anim = null;
      live.current.onInteract?.();
    };
    controls.addEventListener("start", onStart);

    // The wall cut: one clipping plane above the top floor shown (the floors below are entirely under it).
    const cut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    // A ray hit only counts where the wall is still there.
    const clipped = (p: THREE.Vector3) => cut.distanceToPoint(p) >= 0 || renderer.clippingPlanes.length === 0;

    // Double-click / double-tap a room to fly in to it.
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const onDbl = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(floorGroups.filter((g) => g.visible), true).find((h) => h.object.userData.roomId && clipped(h.point));
      const id = hit?.object.userData.roomId as string | undefined;
      if (id) live.current.onPickRoom?.(id);
    };
    renderer.domElement.addEventListener("dblclick", onDbl);

    const resize = () => {
      width = host.clientWidth || 1;
      height = host.clientHeight || 1;
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = `${width}px`;
      renderer.domElement.style.height = `${height}px`;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    home(true);

    // Labels: one per room, placed over its middle each frame.
    // Biggest first: when labels would overlap, the bigger room keeps its name.
    const area = (r: HouseModel["rooms"][number]) => (r.box.x1 - r.box.x0) * (r.box.z1 - r.box.z0);
    const labelRooms = model.rooms.filter((r) => !r.parent).sort((a, c) => area(c) - area(a));
    const labelEls = new Map<string, HTMLButtonElement>();
    const labelHost = labelsRef.current!;
    for (const r of labelRooms) {
      const el = document.createElement("button");
      el.className = "doll-label";
      el.textContent = r.label;
      el.style.visibility = "hidden";
      el.addEventListener("click", () => live.current.onPickRoom?.(r.id));
      labelHost.appendChild(el);
      labelEls.set(r.id, el);
    }

    let lastFocus = live.current.focus.n;
    let lastView = live.current.view.n;
    let lastFloor = live.current.floor;
    const v = new THREE.Vector3();
    const clock = new THREE.Clock();
    const tick = () => {
      const dt = Math.min(0.05, clock.getDelta());
      const p = live.current;
      if (p.focus.n !== lastFocus) {
        lastFocus = p.focus.n;
        if (p.focus.roomId) focusRoom(p.focus.roomId);
      }
      if (p.view.n !== lastView) {
        lastView = p.view.n;
        if (p.view.kind === "reset") home();
        else if (p.view.kind === "top") topDown();
        else zoom(p.view.kind === "in" ? 0.7 : 1 / 0.7);
      }
      if (p.floor !== lastFloor) {
        // Changing floor slides the view up or down to it, keeping the angle and distance.
        lastFloor = p.floor;
        const dy = floorElev() + WALL_H * 0.3 - controls.target.y;
        moveTo(controls.target.clone().setY(controls.target.y + dy), camera.position.clone().setY(camera.position.y + dy));
      }

      const elev = floorElev();
      floorGroups.forEach((g, i) => (g.visible = model.floors[i].elevation <= elev + 0.1));
      siding.forEach((m) => (m.visible = p.siding));
      if (p.wallCut < 0.999) {
        cut.constant = elev + 0.02 + WALL_H * p.wallCut;
        renderer.clippingPlanes = [cut];
      } else renderer.clippingPlanes = [];

      if (anim) {
        anim.t = Math.min(1, anim.t + dt / 0.7);
        const k = anim.t * anim.t * (3 - 2 * anim.t);
        controls.target.lerpVectors(anim.fromT, anim.toT, k);
        camera.position.lerpVectors(anim.fromP, anim.toP, k);
        if (anim.t >= 1) anim = null;
      }
      controls.autoRotate = p.autoRotate && !anim;
      controls.update(dt);
      house.update(camera.position);
      renderer.render(scene, camera);

      // Labels for rooms on the top floor shown (the ones below are under it), skipping any that would overlap.
      const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
      for (const r of labelRooms) {
        const el = labelEls.get(r.id)!;
        let show = p.labels && Math.abs(r.elevation - elev) < 0.1;
        if (show) {
          v.set((r.box.x0 + r.box.x1) / 2, r.elevation + 0.3, (r.box.z0 + r.box.z1) / 2).project(camera);
          const x = ((v.x + 1) / 2) * width, y = ((1 - v.y) / 2) * height;
          const w = (el.offsetWidth || r.label.length * 8 + 16) / 2 + 2, h = (el.offsetHeight || 22) / 2 + 2;
          const rect = { x0: x - w, y0: y - h, x1: x + w, y1: y + h };
          show = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && !taken.some((o) => o.x0 < rect.x1 && rect.x0 < o.x1 && o.y0 < rect.y1 && rect.y0 < o.y1);
          if (show) {
            taken.push(rect);
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
          }
        }
        // visibility, not display, so offsetWidth stays measurable for the overlap test.
        el.style.visibility = show ? "visible" : "hidden";
      }
    };
    renderer.setAnimationLoop(tick);

    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.removeEventListener("start", onStart);
      controls.dispose();
      renderer.domElement.removeEventListener("dblclick", onDbl);
      labelEls.forEach((el) => el.remove());
      house.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [model, photos, wallArt, palette]);

  return (
    <div ref={hostRef} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <div ref={labelsRef} className="doll-labels" />
    </div>
  );
}
