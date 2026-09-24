"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { repairCentroids } from "@/lib/room-graph";
import type { ListingImage, RoomGraph } from "@/lib/types";

interface Props {
  graph: RoomGraph;
  floorPlan: ListingImage | null;
  /** roomId → number of photos */
  photoCounts: Record<string, number>;
  current: string | null;
  onSelect: (roomId: string) => void;
  height?: number;
  /** Camera positions to draw as arrows (normalized plan coords, heading 0 = up, clockwise). */
  cameras?: { x: number; y: number; headingDeg: number }[];
  /** Start zoomed onto this area (normalized plan coords), e.g. the room being edited. */
  focus?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** When set, a tap anywhere on the plan reports its normalized plan coordinates instead of selecting a room. */
  onPlanTap?: (p: { x: number; y: number }) => void;
}

const COLORS = {
  current: new THREE.Color("#ffb347"),
  photos: new THREE.Color("#35c2a1"),
  empty: new THREE.Color("#6b7280"),
  edge: new THREE.Color("#9fb3c8"),
  neighbor: new THREE.Color("#ffd89a"),
};

/**
 * The house as a node graph laid over its floor plan. Coordinates are the
 * normalized plan coordinates from the room graph, so it lines up with the
 * image whatever its size.
 */
export default function FloorPlanGraph({ graph, floorPlan, photoCounts, current, onSelect, height = 320, cameras, onPlanTap, focus }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const live = useRef({ current, onSelect, photoCounts, onPlanTap });
  useEffect(() => {
    live.current = { current, onSelect, photoCounts, onPlanTap };
  });

  // Zoom/pan survives scene rebuilds (the camera editor rebuilds on every tap).
  const view = useRef({ zoom: 1, cx: NaN, cy: NaN });
  const focusRef = useRef(focus);
  const zoomBy = useRef<(f: number) => void>(() => {});
  const [zoomed, setZoomed] = useState(false);

  // Rebuild only when the cameras actually change, not on every parent render.
  const camerasKey = JSON.stringify(cameras ?? []);

  useEffect(() => {
    const camerasList = JSON.parse(camerasKey) as NonNullable<Props["cameras"]>;
    const host = hostRef.current!;
    const aspect = floorPlan ? floorPlan.width / floorPlan.height : 1;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.prepend(renderer.domElement);
    renderer.domElement.style.display = "block";

    // World units: x ∈ [0, aspect], y ∈ [0, 1] with y up (plan y is flipped).
    const W = aspect, H = 1;
    const toWorld = (p: { x: number; y: number }) => new THREE.Vector3(p.x * W, (1 - p.y) * H, 0);
    const camera = new THREE.OrthographicCamera(0, W, H, 0, -10, 10);
    const scene = new THREE.Scene();
    const disposables: { dispose(): void }[] = [];

    if (floorPlan) {
      const tex = new THREE.TextureLoader().load(floorPlan.dataUrl);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, color: "#c4c8cf" });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
      plane.position.set(W / 2, H / 2, -1);
      scene.add(plane);
      disposables.push(tex, mat, plane.geometry);
    }

    // Projects saved before centres were checked can hold centres outside their
    // rooms; draw from a repaired copy (the saved graph is left alone so cache
    // keys, and the Gemini results behind them, stay valid).
    const rooms = repairCentroids(graph.rooms.map((r) => ({ ...r })));
    const byId = new Map(rooms.map((r) => [r.id, r]));
    const r0 = 0.022 * Math.max(W, H);

    // Room outlines
    const outlines = new Map<string, THREE.Mesh>();
    for (const room of graph.rooms) {
      if (!room.bbox) continue;
      const a = toWorld({ x: room.bbox.x0, y: room.bbox.y1 }), b = toWorld({ x: room.bbox.x1, y: room.bbox.y0 });
      const mat = new THREE.MeshBasicMaterial({ color: COLORS.photos, transparent: true, opacity: 0.08 });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(b.x - a.x, b.y - a.y), mat);
      m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, -0.5);
      scene.add(m);
      outlines.set(room.id, m);
      disposables.push(mat, m.geometry);
    }

    // Edges
    const edgeKeys: [string, string][] = [];
    for (const room of graph.rooms) for (const n of room.neighbors) if (room.id < n && byId.has(n)) edgeKeys.push([room.id, n]);
    const edgeLines = edgeKeys.map(([a, b]) => {
      const geo = new THREE.BufferGeometry().setFromPoints([toWorld(byId.get(a)!.centroid), toWorld(byId.get(b)!.centroid)]);
      const mat = new THREE.LineBasicMaterial({ color: COLORS.edge, transparent: true, opacity: 0.8 });
      const line = new THREE.Line(geo, mat);
      scene.add(line);
      disposables.push(geo, mat);
      return { a, b, mat };
    });

    // Nodes
    const nodeGeo = new THREE.CircleGeometry(r0, 32);
    const ringGeo = new THREE.RingGeometry(r0 * 1.25, r0 * 1.55, 40);
    disposables.push(nodeGeo, ringGeo);
    const nodes = rooms.map((room) => {
      const mat = new THREE.MeshBasicMaterial({ color: COLORS.empty });
      const mesh = new THREE.Mesh(nodeGeo, mat);
      mesh.position.copy(toWorld(room.centroid));
      mesh.userData.roomId = room.id;
      scene.add(mesh);
      disposables.push(mat);
      return { room, mesh, mat };
    });
    const ringMat = new THREE.MeshBasicMaterial({ color: COLORS.current, transparent: true });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    scene.add(ring);
    disposables.push(ringMat);

    // Camera arrows: where each photo was taken and which way it faces.
    const camMat = new THREE.MeshBasicMaterial({ color: "#e8590c", side: THREE.DoubleSide });
    disposables.push(camMat);
    const camMeshes: THREE.Mesh[] = [];
    for (const c of camerasList) {
      const h = (c.headingDeg * Math.PI) / 180;
      const dir = new THREE.Vector3(Math.sin(h), Math.cos(h), 0), perp = new THREE.Vector3(dir.y, -dir.x, 0);
      const p = toWorld(c);
      const len = r0 * 1.8, w = r0 * 0.7;
      // Built around the camera point so it can be scaled in place (constant size on screen when zoomed).
      const o = new THREE.Vector3();
      const geo = new THREE.BufferGeometry().setFromPoints([
        o.clone().addScaledVector(dir, len),
        o.clone().addScaledVector(perp, w),
        o.clone().addScaledVector(perp, -w),
      ]);
      geo.setIndex([0, 1, 2]);
      const tri = new THREE.Mesh(geo, camMat);
      tri.position.set(p.x, p.y, 0.5);
      scene.add(tri);
      camMeshes.push(tri);
      disposables.push(geo);
    }

    // Labels (HTML, so they stay crisp)
    const labelEls = new Map<string, HTMLButtonElement>();
    const labels = labelsRef.current!;
    labels.innerHTML = "";
    for (const room of graph.rooms) {
      const el = document.createElement("button");
      el.className = "plan-label";
      el.textContent = room.label;
      el.onclick = () => live.current.onSelect(room.id);
      labels.appendChild(el);
      labelEls.set(room.id, el);
    }

    let cw = 0, ch = 0;
    // Half-extents (world units) of the whole plan fitted into the box, at zoom 1.
    let fitHW = W / 2, fitHH = H / 2;
    const v = view.current;
    const firstView = !Number.isFinite(v.cx);
    if (firstView) {
      v.cx = W / 2;
      v.cy = H / 2;
    }
    const applyView = () => {
      v.zoom = Math.min(8, Math.max(1, v.zoom));
      const hw = fitHW / v.zoom, hh = fitHH / v.zoom;
      // Keep the plan in view: the centre can't wander past the plan's edges.
      v.cx = v.zoom === 1 ? W / 2 : Math.min(W, Math.max(0, v.cx));
      v.cy = v.zoom === 1 ? H / 2 : Math.min(H, Math.max(0, v.cy));
      camera.left = v.cx - hw; camera.right = v.cx + hw; camera.top = v.cy + hh; camera.bottom = v.cy - hh;
      camera.updateProjectionMatrix();
      // At zoom 1 a one-finger swipe scrolls the page; zoomed in, it pans the plan.
      renderer.domElement.style.touchAction = v.zoom > 1 ? "none" : "pan-y";
      setZoomed(v.zoom > 1.01);
    };
    const layout = () => {
      cw = host.clientWidth;
      ch = host.clientHeight;
      renderer.setSize(cw, ch, false);
      renderer.domElement.style.width = `${cw}px`;
      renderer.domElement.style.height = `${ch}px`;
      // Fit the plan into the box, preserving aspect.
      const boxAspect = cw / ch;
      const pad = 0.04;
      if (boxAspect > W / H) {
        fitHH = H / 2 + pad;
        fitHW = fitHH * boxAspect;
      } else {
        fitHW = W / 2 + pad;
        fitHH = fitHW / boxAspect;
      }
      const f = focusRef.current;
      if (firstView && f && cw > 0) {
        // Frame the focus area with room to spare (it's where the user will tap).
        const fw = (f.x1 - f.x0) * W, fh = (f.y1 - f.y0) * H;
        v.zoom = Math.min(fitHW / (fw * 1.2), fitHH / (fh * 1.2), 5);
        v.cx = ((f.x0 + f.x1) / 2) * W;
        v.cy = (1 - (f.y0 + f.y1) / 2) * H;
        focusRef.current = null;
      }
      applyView();
    };
    const ro = new ResizeObserver(layout);
    ro.observe(host);
    layout();

    // Screen → world, for zooming about a point.
    const toWorldAt = (clientX: number, clientY: number) => {
      const r = renderer.domElement.getBoundingClientRect();
      return {
        x: camera.left + ((clientX - r.left) / r.width) * (camera.right - camera.left),
        y: camera.top - ((clientY - r.top) / r.height) * (camera.top - camera.bottom),
      };
    };
    const zoomAt = (factor: number, clientX: number, clientY: number) => {
      const before = toWorldAt(clientX, clientY);
      v.zoom *= factor;
      applyView();
      const after = toWorldAt(clientX, clientY);
      v.cx += before.x - after.x;
      v.cy += before.y - after.y;
      applyView();
    };
    zoomBy.current = (f: number) => {
      const r = renderer.domElement.getBoundingClientRect();
      if (f === 0) v.zoom = 1;
      else zoomAt(f, r.left + r.width / 2, r.top + r.height / 2);
      applyView();
    };

    // Pinch to zoom, drag to pan (when zoomed), wheel to zoom; a clean tap still selects/places.
    const pointers = new Map<number, { x: number; y: number }>();
    let gesture: { moved: boolean; start: { x: number; y: number }; pinch: { dist: number; zoom: number } | null } = {
      moved: false,
      start: { x: 0, y: 0 },
      pinch: null,
    };
    const onDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      renderer.domElement.setPointerCapture(e.pointerId);
      if (pointers.size === 1) gesture = { moved: false, start: { x: e.clientX, y: e.clientY }, pinch: null };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: v.zoom };
        gesture.moved = true;
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      if (pointers.size === 2 && gesture.pinch) {
        pointers.set(e.pointerId, cur);
        const [a, b] = [...pointers.values()];
        const want = gesture.pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, gesture.pinch.dist));
        zoomAt(want / v.zoom, (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      const dx = cur.x - prev.x, dy = cur.y - prev.y;
      if (Math.hypot(dx, dy) > 0 && v.zoom > 1) {
        v.cx -= (dx / cw) * (camera.right - camera.left);
        v.cy += (dy / ch) * (camera.top - camera.bottom);
        applyView();
      }
      pointers.set(e.pointerId, cur);
      // More than a few pixels from where the finger went down: a drag, not a tap.
      if (Math.hypot(cur.x - gesture.start.x, cur.y - gesture.start.y) > 8) gesture.moved = true;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    const raycaster = new THREE.Raycaster();
    const onClick = (e: PointerEvent) => {
      const wasGesture = gesture.moved || pointers.size > 1;
      pointers.delete(e.pointerId);
      if (wasGesture || e.type !== "pointerup") return;
      const r = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (live.current.onPlanTap) {
        const w = new THREE.Vector3(ndc.x, ndc.y, 0).unproject(camera);
        return live.current.onPlanTap({ x: Math.min(1, Math.max(0, w.x / W)), y: Math.min(1, Math.max(0, 1 - w.y / H)) });
      }
      const hit = raycaster.intersectObjects(nodes.map((n) => n.mesh))[0];
      if (hit) return live.current.onSelect(hit.object.userData.roomId);
      // Generous touch target: nearest node within ~3 radii.
      const p = new THREE.Vector3(ndc.x, ndc.y, 0).unproject(camera);
      let best: { id: string; d: number } | null = null;
      for (const n of nodes) {
        const d = n.mesh.position.distanceTo(new THREE.Vector3(p.x, p.y, 0));
        if (d < r0 * 3 && (!best || d < best.d)) best = { id: n.room.id, d };
      }
      if (best) live.current.onSelect(best.id);
    };
    renderer.domElement.addEventListener("pointerup", onClick);
    renderer.domElement.addEventListener("pointercancel", onClick);

    const labelSize = new Map<string, number>();
    let raf = 0;
    const clock = new THREE.Clock();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = clock.getElapsedTime();
      const { current, photoCounts } = live.current;
      const neighbors = new Set(current ? byId.get(current)?.neighbors ?? [] : []);
      for (const n of nodes) {
        const isCur = n.room.id === current;
        n.mat.color.copy(isCur ? COLORS.current : photoCounts[n.room.id] ? COLORS.photos : COLORS.empty);
        n.mesh.scale.setScalar((isCur ? 1.25 : neighbors.has(n.room.id) ? 1.1 : 1) / v.zoom);
        const o = outlines.get(n.room.id);
        if (o) {
          const m = o.material as THREE.MeshBasicMaterial;
          m.color.copy(isCur ? COLORS.current : COLORS.photos);
          m.opacity = isCur ? 0.22 : neighbors.has(n.room.id) ? 0.12 : 0.05;
        }
      }
      for (const e of edgeLines) {
        const active = current === e.a || current === e.b;
        e.mat.color.copy(active ? COLORS.neighbor : COLORS.edge);
        e.mat.opacity = active ? 1 : 0.55;
      }
      const cur = current ? nodes.find((n) => n.room.id === current) : null;
      ring.visible = !!cur;
      if (cur) {
        ring.position.copy(cur.mesh.position);
        const s = 1 + 0.25 * (0.5 + 0.5 * Math.sin(t * 3));
        ring.scale.setScalar(s / v.zoom);
        ringMat.opacity = 0.9 - 0.5 * (s - 1) * 4;
      }
      for (const m of camMeshes) m.scale.setScalar(1 / Math.sqrt(v.zoom));
      renderer.render(scene, camera);
      // Position labels; hide any that would overlap one already shown (the
      // current room first, then rooms with photos). Zooming in reveals them.
      const shown: { l: number; r: number; t: number; b: number }[] = [];
      const order = [...nodes].sort((a, b) => rank(b) - rank(a));
      function rank(n: (typeof nodes)[number]) {
        return (n.room.id === current ? 4 : 0) + (photoCounts[n.room.id] ? 2 : 0);
      }
      for (const n of order) {
        const el = labelEls.get(n.room.id)!;
        const p = n.mesh.position.clone().project(camera);
        const x = ((p.x + 1) / 2) * cw, y = ((1 - p.y) / 2) * ch + 14;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.dataset.state = n.room.id === current ? "current" : photoCounts[n.room.id] ? "photos" : "empty";
        const w = (labelSize.get(n.room.id) ?? labelSize.set(n.room.id, el.offsetWidth || 60).get(n.room.id)!) + 4;
        const box = { l: x - w / 2, r: x + w / 2, t: y, b: y + 20 };
        const off = x < 0 || x > cw || y < 0 || y > ch;
        const clash = shown.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t);
        el.style.visibility = off || clash ? "hidden" : "visible";
        if (!off && !clash) shown.push(box);
      }
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerup", onClick);
      renderer.domElement.removeEventListener("pointercancel", onClick);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("wheel", onWheel);
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      labels.innerHTML = "";
    };
  }, [graph, floorPlan, camerasKey]);

  return (
    <div ref={hostRef} style={{ position: "relative", width: "100%", height }}>
      <div ref={labelsRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }} />
      <div className="plan-zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy.current(1.6)}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy.current(1 / 1.6)}>−</button>
        {zoomed && (
          <button type="button" aria-label="Show whole plan" onClick={() => zoomBy.current(0)}>
            ⤢
          </button>
        )}
      </div>
    </div>
  );
}
