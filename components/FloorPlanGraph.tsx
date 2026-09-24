"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
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
export default function FloorPlanGraph({ graph, floorPlan, photoCounts, current, onSelect, height = 320, cameras, onPlanTap }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const live = useRef({ current, onSelect, photoCounts, onPlanTap });
  useEffect(() => {
    live.current = { current, onSelect, photoCounts, onPlanTap };
  });

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

    const byId = new Map(graph.rooms.map((r) => [r.id, r]));
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
    const nodes = graph.rooms.map((room) => {
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
    for (const c of camerasList) {
      const h = (c.headingDeg * Math.PI) / 180;
      const dir = new THREE.Vector3(Math.sin(h), Math.cos(h), 0), perp = new THREE.Vector3(dir.y, -dir.x, 0);
      const p = toWorld(c);
      const len = r0 * 1.8, w = r0 * 0.7;
      const geo = new THREE.BufferGeometry().setFromPoints([
        p.clone().addScaledVector(dir, len),
        p.clone().addScaledVector(perp, w),
        p.clone().addScaledVector(perp, -w),
      ]);
      geo.setIndex([0, 1, 2]);
      const tri = new THREE.Mesh(geo, camMat);
      tri.position.z = 0.5;
      scene.add(tri);
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
        const w = H * boxAspect;
        camera.left = W / 2 - w / 2 - pad; camera.right = W / 2 + w / 2 + pad; camera.top = H + pad; camera.bottom = -pad;
      } else {
        const h = W / boxAspect;
        camera.left = -pad; camera.right = W + pad; camera.top = H / 2 + h / 2 + pad; camera.bottom = H / 2 - h / 2 - pad;
      }
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(layout);
    ro.observe(host);
    layout();

    const raycaster = new THREE.Raycaster();
    const onClick = (e: PointerEvent) => {
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
        n.mesh.scale.setScalar(isCur ? 1.25 : neighbors.has(n.room.id) ? 1.1 : 1);
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
        ring.scale.setScalar(s);
        ringMat.opacity = 0.9 - 0.5 * (s - 1) * 4;
      }
      renderer.render(scene, camera);
      // Position labels
      for (const n of nodes) {
        const el = labelEls.get(n.room.id)!;
        const v = n.mesh.position.clone().project(camera);
        el.style.left = `${((v.x + 1) / 2) * cw}px`;
        el.style.top = `${((1 - v.y) / 2) * ch + 14}px`;
        el.dataset.state = n.room.id === current ? "current" : photoCounts[n.room.id] ? "photos" : "empty";
      }
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerup", onClick);
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      labels.innerHTML = "";
    };
  }, [graph, floorPlan, camerasKey]);

  return (
    <div ref={hostRef} style={{ position: "relative", width: "100%", height }}>
      <div ref={labelsRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
    </div>
  );
}
