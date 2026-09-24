"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProject } from "@/lib/client/project";
import { buildRoomModel, type RoomModel } from "@/lib/client/room-model";
import { requestGyroPermission } from "@/lib/client/gyro";
import StereoControls from "@/components/StereoControls";
import type { StereoLayout } from "@/components/StereoViewer";
import type { Room, RoomGraph } from "@/lib/types";

const StereoViewer = dynamic(() => import("@/components/StereoViewer"), { ssr: false });
const FloorPlanGraph = dynamic(() => import("@/components/FloorPlanGraph"), { ssr: false });

interface Shown {
  key: number;
  roomId: string;
  model: RoomModel | null;
  phase: "enter" | "shown" | "exit";
}

const START_PREFERENCE = ["entry", "living", "kitchen", "dining"];

export default function TourPage() {
  const { project, photos, floorPlan, ready } = useProject();
  const [layout, setLayout] = useState<StereoLayout>("cross");
  const [strength, setStrength] = useState(1);
  const [gyro, setGyro] = useState(false);
  const [gyroMsg, setGyroMsg] = useState<string | null>(null);
  const [tryMerge, setTryMerge] = useState(true);
  const [full, setFull] = useState(false);
  const [picked, setCurrent] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [shown, setShown] = useState<Shown[]>([]);
  const keyRef = useRef(0);
  const models = useRef(new Map<string, RoomModel>());
  const stageRef = useRef<HTMLDivElement>(null);

  // Without a room graph (no floor plan / no Gemini), every photo is its own "room".
  const graph: RoomGraph | null = useMemo(() => {
    if (project.graph) return project.graph;
    const withDepth = photos.filter((p) => project.depth[p.id]);
    if (!withDepth.length) return null;
    return {
      rooms: withDepth.map((p, i) => ({
        id: `photo_${p.id}`,
        label: p.label ?? `Photo ${i + 1}`,
        type: "other",
        neighbors: [withDepth[i - 1], withDepth[i + 1]].filter(Boolean).map((q) => `photo_${q!.id}`),
        centroid: { x: 0, y: 0 },
      })),
    };
  }, [project.graph, project.depth, photos]);

  const roomPhotos = useMemo(() => {
    const out: Record<string, string[]> = {};
    if (!graph) return out;
    if (!project.graph) {
      for (const r of graph.rooms) out[r.id] = [r.id.slice("photo_".length)];
      return out;
    }
    for (const m of Object.values(project.matches)) {
      if (m.roomId && project.depth[m.photoId] && photos.some((p) => p.id === m.photoId)) (out[m.roomId] ??= []).push(m.photoId);
    }
    return out;
  }, [graph, project.graph, project.matches, project.depth, photos]);

  const photoCounts = useMemo(() => Object.fromEntries(Object.entries(roomPhotos).map(([k, v]) => [k, v.length])), [roomPhotos]);
  const roomById = useMemo(() => new Map((graph?.rooms ?? []).map((r) => [r.id, r])), [graph]);

  // Starting room: the entry/living area if it has photos, else any room that does.
  const current = useMemo(() => {
    if (picked && roomById.has(picked)) return picked;
    if (!graph) return null;
    const candidates = graph.rooms.filter((r) => photoCounts[r.id]);
    const start =
      START_PREFERENCE.map((t) => candidates.find((r) => r.type === t)).find(Boolean) ?? candidates[0] ?? graph.rooms[0];
    return start?.id ?? null;
  }, [picked, graph, photoCounts, roomById]);

  const modelFor = useCallback(
    async (room: Room): Promise<RoomModel | null> => {
      const ids = roomPhotos[room.id] ?? [];
      if (!ids.length || !graph) return null;
      const key = `${room.id}:${ids.join(",")}:${tryMerge}`;
      const hit = models.current.get(key);
      if (hit) return hit;
      const model = await buildRoomModel({
        room,
        graph,
        planAspect: floorPlan ? floorPlan.width / floorPlan.height : 1,
        photos: ids.map((id) => photos.find((p) => p.id === id)!).filter(Boolean),
        matches: project.matches,
        depth: project.depth,
        tryMerge,
      });
      models.current.set(key, model);
      return model;
    },
    [roomPhotos, graph, floorPlan, photos, project.matches, project.depth, tryMerge],
  );

  // Room change → build model, then crossfade.
  useEffect(() => {
    if (!current) return;
    const room = roomById.get(current);
    if (!room) return;
    let alive = true;
    modelFor(room).then((model) => {
      if (!alive) return;
      setActive(0);
      const key = ++keyRef.current;
      setShown((prev) => [...prev.filter((s) => s.phase !== "exit").map((s) => ({ ...s, phase: "exit" as const })), { key, roomId: current, model, phase: "enter" }]);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setShown((prev) => prev.map((s) => (s.key === key ? { ...s, phase: "shown" } : s)))),
      );
      setTimeout(() => setShown((prev) => prev.filter((s) => s.phase !== "exit" || s.key > key)), 650);
    });
    return () => {
      alive = false;
    };
  }, [current, modelFor, roomById]);

  const top = shown.filter((s) => s.phase !== "exit").at(-1);
  const building = !!current && top?.roomId !== current;

  // Pre-build neighbours' models so transitions are instant.
  useEffect(() => {
    if (!current || building) return;
    const room = roomById.get(current);
    const t = setTimeout(() => room?.neighbors.forEach((n) => roomById.get(n) && void modelFor(roomById.get(n)!)), 400);
    return () => clearTimeout(t);
  }, [current, building, roomById, modelFor]);

  async function toggleGyro() {
    if (gyro) return setGyro(false);
    const result = await requestGyroPermission();
    if (result === "granted") {
      setGyro(true);
      setGyroMsg(null);
    } else setGyroMsg(result === "denied" ? "Motion access was denied. Enable it in browser settings." : "This device has no motion sensor.");
  }

  function toggleFull() {
    const next = !full;
    setFull(next);
    const el = stageRef.current;
    if (next && el?.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (!next && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  useEffect(() => {
    const onFs = () => !document.fullscreenElement && setFull(false);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  if (!ready) return <main className="shell"><p className="muted">Loading…</p></main>;
  if (!graph)
    return (
      <main className="shell">
        <h1>Tour</h1>
        <p className="muted">
          Nothing to show yet. Estimate depth for at least one photo on the <Link href="/analyze">Analyze</Link> page.
        </p>
      </main>
    );

  const room = current ? roomById.get(current) : null;
  const model = top?.model ?? null;
  const layerCount = model?.layers.length ?? 0;
  const layer = model?.layers[Math.min(active, layerCount - 1)];
  const unplaced = !!model?.layers.some((l) => project.matches[l.photo.id]?.headingDeg == null);

  return (
    <main className="tour">
      <div ref={stageRef} className={`stage ${full ? "full" : ""}`} data-sbs={layout === "cross" || layout === "parallel"}>
        {shown.map((s) => (
          <div key={s.key} className={`stage-layer ${s.phase === "enter" ? "enter" : s.phase === "exit" ? "exit" : ""}`}>
            {s.model ? (
              <StereoViewer
                model={s.model}
                layout={layout}
                strength={strength}
                activeLayer={s.key === top?.key ? active : 0}
                gyro={gyro}
                exiting={s.phase === "exit"}
              />
            ) : (
              <div className="center-msg">
                <div>
                  <strong>{roomById.get(s.roomId)?.label}</strong>
                  <p>No photos of this room. Keep walking using the rooms below.</p>
                </div>
              </div>
            )}
          </div>
        ))}
        {building && <div className="center-msg" style={{ pointerEvents: "none" }}><span className="spinner" /></div>}
        {room && <div className="stage-title">{room.label}</div>}
        <div className="stage-tools">
          {layerCount > 1 && (
            <button className="btn small" onClick={() => setActive((a) => (a + 1) % layerCount)} title="Next viewpoint in this room">
              {model?.mode === "merged" ? "Viewpoint" : "Photo"} {active + 1}/{layerCount} ›
            </button>
          )}
          <button className="btn small" onClick={toggleGyro} aria-pressed={gyro}>
            {gyro ? "Tilt ✓" : "Tilt"}
          </button>
          <button className="btn small" onClick={toggleFull}>{full ? "Exit" : "⤢"}</button>
        </div>
      </div>

      <div className="controls">
        <StereoControls layout={layout} setLayout={setLayout} strength={strength} setStrength={setStrength} />
        {gyroMsg && <div className="notice small">{gyroMsg}</div>}
        {room && (
          <div className="chips" aria-label="Adjacent rooms">
            {room.neighbors.map((n) => {
              const r = roomById.get(n);
              if (!r) return null;
              return (
                <button key={n} className={`chip ${photoCounts[n] ? "" : "dim"}`} onClick={() => setCurrent(n)}>
                  {r.label} →
                </button>
              );
            })}
            {!room.neighbors.length && <span className="small muted">No connected rooms. Tap the map below.</span>}
          </div>
        )}
        {model && (
          <div className="row small muted" style={{ justifyContent: "space-between" }}>
            <span>
              {model.mode === "merged"
                ? `${model.layers.filter((l) => l.registered).length} photos merged into one 3D room · drag to look around`
                : layerCount > 1
                  ? `${layerCount} photos, shown one at a time${
                      !tryMerge ? "" : unplaced ? " · run Place cameras on Analyze to merge them" : " (couldn't align them)"
                    }`
                  : "Single photo · depth-shifted stereo"}
              {layer && !layer.registered && model.mode === "merged" && " · this photo isn't aligned"}
              {model.depthSource === "heuristic" && " · rough depth guess"}
            </span>
            {layerCount > 1 && (
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={tryMerge} onChange={(e) => setTryMerge(e.target.checked)} /> merge photos
              </label>
            )}
          </div>
        )}
      </div>

      <div className="shell" style={{ paddingTop: 12, width: "100%" }}>
        {project.graph && (
          <div className="card" style={{ padding: 8, margin: "0 0 12px" }}>
            <FloorPlanGraph graph={project.graph} floorPlan={floorPlan} photoCounts={photoCounts} current={current} onSelect={setCurrent} height={280} />
          </div>
        )}
        {!project.graph && (
          <div className="chips" style={{ marginBottom: 12 }}>
            {graph.rooms.map((r) => (
              <button key={r.id} className={`chip ${r.id === current ? "" : "dim"}`} onClick={() => setCurrent(r.id)}>{r.label}</button>
            ))}
          </div>
        )}
        <details className="card">
          <summary><strong>How to see the 3D (cross-eye)</strong></summary>
          <ol className="small muted">
            <li>Hold the phone about 30 cm away, level with your eyes.</li>
            <li>Look at the white dots above the two images, then slowly cross your eyes (try focusing on a fingertip halfway to the screen).</li>
            <li>The two dots become three. Hold the middle one steady, and the middle image appears in depth.</li>
            <li>If it hurts or won&apos;t fuse, lower the Depth slider, or try <em>Wiggle</em> mode, which needs no eye tricks.</li>
          </ol>
          <p className="small muted">Tip: turn on <em>Tilt</em> so small phone movements shift the view like moving your head.</p>
        </details>
      </div>
    </main>
  );
}
