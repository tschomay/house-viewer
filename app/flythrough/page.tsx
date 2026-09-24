"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CostNote from "@/components/CostNote";
import StereoControls from "@/components/StereoControls";
import type { DepthLayer, FlyState, RoomColors } from "@/components/HouseFlythrough";
import type { StereoLayout } from "@/components/StereoViewer";
import { beginRun, recordUsage } from "@/lib/client/cost";
import { requestGyroPermission } from "@/lib/client/gyro";
import { roomPalette } from "@/lib/client/house-palette";
import { buildLayer } from "@/lib/client/room-model";
import { DEFAULT_INTRINSICS, farFromRoomSize } from "@/lib/geometry";
import { usePairWidth, usePref } from "@/lib/client/prefs";
import { useProject, useServerStatus } from "@/lib/client/project";
import { runWallArtJob, WALL_ART_USD_PER_ROOM, wallArtJobs } from "@/lib/client/wall-art";
import { formatUsd } from "@/lib/cost";
import { buildFlightPath, buildHouseModel } from "@/lib/house-model";

const HouseFlythrough = dynamic(() => import("@/components/HouseFlythrough"), { ssr: false });

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3];
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export default function FlythroughPage() {
  const { project, dispatch, photos, floorPlan, ready } = useProject();
  const status = useServerStatus();
  const [layout, setLayout] = usePref<StereoLayout>("flyLayout", "mono");
  const [strength, setStrength] = usePref<number>("strength", 1);
  const [pairWidth, setPairWidth] = usePairWidth();
  const [speed, setSpeed] = usePref<number>("flySpeed", 1);
  const [playing, setPlaying] = useState(false);
  const [seek, setSeek] = useState({ t: 0, n: 0 });
  const [recenter, setRecenter] = useState(0);
  const [gyro, setGyro] = useState(false);
  const [gyroMsg, setGyroMsg] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [fly, setFly] = useState<FlyState>({ t: 0, roomId: null, photoId: null });
  const [xrEnter, setXrEnter] = useState<(() => Promise<void>) | null>(null);
  const [palette, setPalette] = useState<Record<string, RoomColors> | null>(null);
  const [depthLayers, setDepthLayers] = useState<DepthLayer[] | null>(null);
  const [imagine, setImagine] = useState(false);
  const [careful, setCareful] = useState(false);
  const [artBusy, setArtBusy] = useState<{ done: number; total: number } | null>(null);
  const [artErrors, setArtErrors] = useState<string[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);

  const photosById = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const aspect = floorPlan ? floorPlan.width / floorPlan.height : 1;
  const model = useMemo(() => (project.graph ? buildHouseModel(project.graph, aspect, project.matches) : null), [project.graph, aspect, project.matches]);
  const path = useMemo(() => (model ? buildFlightPath(model) : null), [model]);
  const wallArt = project.wallArt ?? {};
  const labelOf = useMemo(() => new Map((model?.rooms ?? []).map((r) => [r.id, r.label])), [model]);

  useEffect(() => {
    if (!model) return;
    let alive = true;
    void roomPalette(model, photosById).then((p) => alive && setPalette(p));
    return () => {
      alive = false;
    };
  }, [model, photosById]);

  // Depth meshes for placed photos that have depth maps (from the Analyze page). Built once, on device.
  useEffect(() => {
    if (!model) return;
    let alive = true;
    const sizes = new Map((project.graph?.rooms ?? []).map((r) => [r.id, r.sizeM]));
    const shots = model.rooms.flatMap((r) => r.photos).filter((p) => project.depth[p.photoId] && photosById.has(p.photoId));
    void (async () => {
      const out: DepthLayer[] = [];
      for (const s of shots) {
        const photo = photosById.get(s.photoId)!;
        const intr = { ...DEFAULT_INTRINSICS, far: farFromRoomSize(sizes.get(project.matches[s.photoId]?.roomId ?? "")) };
        try {
          const l = await buildLayer(photo, project.depth[s.photoId], intr);
          out.push({ photoId: s.photoId, positions: l.positions, uvs: l.uvs, indices: l.indices });
        } catch {
          /* a bad depth map just means no 3D pop for that photo */
        }
        if (!alive) return;
      }
      setDepthLayers(out);
    })();
    return () => {
      alive = false;
    };
  }, [model, project.depth, project.graph, project.matches, photosById]);

  const jobs = useMemo(() => (model ? wallArtJobs(model, project.matches, { imagine, careful }) : []), [model, project.matches, imagine, careful]);
  const todo = jobs.filter((j) => wallArt[j.roomId]?.key !== j.key);
  const perRoom = WALL_ART_USD_PER_ROOM * (careful ? 2 : 1);

  const onState = useCallback((s: FlyState) => setFly((f) => (f.t === s.t && f.roomId === s.roomId && f.photoId === s.photoId ? f : s)), []);
  const onEnd = useCallback(() => setPlaying(false), []);
  const onXr = useCallback((enter: (() => Promise<void>) | null) => setXrEnter(() => enter), []);
  const jump = useCallback((t: number) => setSeek((s) => ({ t, n: s.n + 1 })), []);

  // Keyboard: space plays/pauses, arrows skip, +/- change speed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea")) return;
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowRight") jump(fly.t + 10);
      else if (e.key === "ArrowLeft") jump(Math.max(0, fly.t - 10));
      else if (e.key === "+" || e.key === "=") setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)] ?? 1);
      else if (e.key === "-") setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)] ?? 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fly.t, jump, speed, setSpeed]);

  async function generateArt() {
    if (!todo.length) return;
    setArtErrors([]);
    beginRun("walls");
    setArtBusy({ done: 0, total: todo.length });
    let done = 0;
    const queue = [...todo];
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          try {
            const { art, usage } = await runWallArtJob(job, photosById, careful);
            recordUsage("walls", usage);
            dispatch({ type: "wallArt", art });
          } catch (e) {
            setArtErrors((errs) => [...errs, `${job.label}: ${(e as Error).message}`]);
          }
          setArtBusy({ done: ++done, total: todo.length });
        }
      }),
    );
    setArtBusy(null);
  }

  async function toggleGyro() {
    if (gyro) return setGyro(false);
    const result = await requestGyroPermission();
    if (result === "granted") {
      setGyro(true);
      setRecenter((n) => n + 1);
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
  if (!model || !path || !path.samples.length)
    return (
      <main className="shell">
        <h1>3D fly-through</h1>
        <p className="muted">
          The fly-through builds a 3D model of the whole house from the floor plan&apos;s room map. Read the floor plan and sort the photos on the{" "}
          <Link href="/analyze">Analyze</Link> page first.
        </p>
      </main>
    );

  const placed = model.rooms.reduce((n, r) => n + r.photos.length, 0);
  const assigned = Object.values(project.matches).filter((m) => m.roomId).length;
  const artRooms = Object.keys(wallArt).filter((id) => labelOf.has(id)).length;
  const imaginedHere = !!fly.roomId && wallArt[fly.roomId]?.imagined;
  const chapter = [...path.chapters].reverse().find((c) => c.t <= fly.t + 0.05);
  const roomLabel = fly.roomId ? labelOf.get(fly.roomId) : chapter ? null : "Arriving";
  const locked = status && !status.gemini;

  return (
    <main className="tour">
      <div ref={stageRef} className={`stage fly ${full ? "full" : ""}`} data-sbs={layout === "cross" || layout === "parallel"}>
        {palette && depthLayers && (
          <HouseFlythrough
            model={model}
            path={path}
            photos={photosById}
            wallArt={wallArt}
            palette={palette}
            depthLayers={depthLayers}
            layout={layout}
            strength={strength}
            pairWidth={pairWidth}
            playing={playing}
            speed={speed}
            seek={seek}
            recenter={recenter}
            gyro={gyro}
            onState={onState}
            onEnd={onEnd}
            onTap={() => setPlaying((p) => !p)}
            onXr={onXr}
          />
        )}
        {!(palette && depthLayers) && <div className="center-msg"><span className="spinner" /></div>}
        <div className="stage-title">
          {roomLabel ?? ""}
          {fly.photoId && <span className="badge ok" style={{ marginLeft: 8 }}>listing photo view</span>}
          {imaginedHere && <span className="badge warn" style={{ marginLeft: 8 }}>AI-imagined room</span>}
        </div>
        <div className="stage-tools" style={{ top: 8, bottom: "auto" }}>
          <button className="btn small" onClick={() => setRecenter((n) => n + 1)} title="Look straight ahead again">⟲ Ahead</button>
          <button className="btn small" onClick={toggleGyro} aria-pressed={gyro} title="Turn the phone to look around">{gyro ? "Tilt ✓" : "Tilt"}</button>
          {xrEnter && (
            <button className="btn small" onClick={() => void xrEnter().then(() => setPlaying(true)).catch(() => {})}>VR</button>
          )}
          <button className="btn small" onClick={toggleFull}>{full ? "Exit" : "⤢"}</button>
        </div>
        <div className="fly-bar" onPointerDown={(e) => e.stopPropagation()}>
          <button className="btn small" onClick={() => (fly.t >= path.duration - 0.05 ? (jump(0), setPlaying(true)) : setPlaying((p) => !p))} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <div className="fly-scrub">
            <input
              type="range"
              min={0}
              max={path.duration}
              step={0.1}
              value={Math.min(path.duration, fly.t)}
              onChange={(e) => jump(Number(e.target.value))}
              aria-label="Position in the fly-through"
            />
            <div className="fly-ticks" aria-hidden>
              {path.chapters.map((c) => (
                <span key={c.roomId + c.t} style={{ left: `${(100 * c.t) / Math.max(1, path.duration)}%` }} />
              ))}
            </div>
          </div>
          <span className="small fly-time">{fmt(fly.t)} / {fmt(path.duration)}</span>
          <label className="small fly-speed" title="Playback speed (+/− keys)">
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed">
              {SPEEDS.map((s) => (
                <option key={s} value={s}>{s}×</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="controls">
        <StereoControls layout={layout} setLayout={setLayout} strength={strength} setStrength={setStrength} pairWidth={pairWidth} setPairWidth={setPairWidth} />
        {gyroMsg && <div className="notice small">{gyroMsg}</div>}
        <div className="chips" aria-label="Rooms on the route">
          {path.chapters.map((c) => (
            <button key={c.roomId + c.t} className={`chip ${chapter?.roomId === c.roomId ? "" : "dim"}`} onClick={() => jump(c.t)}>
              {labelOf.get(c.roomId)}
            </button>
          ))}
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Drag to look around while it flies (or turn on <em>Tilt</em>). Tap the view to pause. Space, ←/→ and +/− work on a keyboard.
        </p>
      </div>

      <div className="shell" style={{ paddingTop: 12, width: "100%" }}>
        <section className="card">
          <div className="card-head">
            <h2>3D house <span className="badge accent">beta</span></h2>
          </div>
          <p className="small muted">
            {model.rooms.filter((r) => !r.parent).length} rooms on {model.floors.length} floor{model.floors.length === 1 ? "" : "s"}, built from the floor plan. Walls
            are painted with the listing photos, projected back from where each was taken, so every stop on the route shows a real photo from its own viewpoint.{" "}
            <strong>{placed}</strong> of {assigned} sorted photos have a camera position and are used
            {depthLayers && depthLayers.length > 0 && <> ({depthLayers.length} with depth, so their furniture stands out in 3D near their viewpoint)</>}
            {placed < assigned && (
              <> (run <Link href="/analyze">Place cameras</Link> for the rest)</>
            )}
            .
          </p>
          <h3 style={{ margin: "14px 0 6px" }}>AI wall fill (optional)</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            Photos never show every wall. Gemini can paint the missing walls of each room from its photos: one image per room (four wall views), ≈{formatUsd(perRoom)} a room.
            Without it, unseen walls are plain paint in the room&apos;s colours. AI walls are an impression, not a record: check the photos for anything that matters.
          </p>
          <div className="row">
            <button className="btn primary" disabled={!!artBusy || !todo.length || !!locked} onClick={() => void generateArt()}>
              {artBusy ? (
                <><span className="spinner" /> {artBusy.done}/{artBusy.total}</>
              ) : todo.length ? (
                `Fill ${todo.length} room${todo.length === 1 ? "" : "s"} (≈${formatUsd(todo.length * perRoom)})`
              ) : (
                "All rooms filled"
              )}
            </button>
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={imagine} onChange={(e) => setImagine(e.target.checked)} /> also imagine rooms with no photos
            </label>
            <label className="row small" style={{ gap: 6 }} title="Gemini 3 Pro Image: sharper, about twice the price">
              <input type="checkbox" checked={careful} onChange={(e) => setCareful(e.target.checked)} /> careful (Pro)
            </label>
          </div>
          {locked && (
            <p className="small muted">AI steps are locked. <Link href="/">Unlock on the Listing page</Link>.</p>
          )}
          {artBusy && <div className="progress"><div style={{ width: `${(100 * artBusy.done) / Math.max(1, artBusy.total)}%` }} /></div>}
          {artErrors.length > 0 && <div className="notice bad" style={{ marginTop: 10 }}>{artErrors.length} room(s) failed: {artErrors[0]}</div>}
          <CostNote action="walls" />
          {artRooms > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="small">
                {artRooms} room{artRooms === 1 ? "" : "s"} with AI walls ·{" "}
                <button className="linklike" onClick={() => dispatch({ type: "clearWallArt" })}>remove all</button>
              </summary>
              <div className="gallery" style={{ marginTop: 8 }}>
                {Object.values(wallArt)
                  .filter((a) => labelOf.has(a.roomId))
                  .map((a) => (
                    <figure key={a.roomId} style={{ margin: 0 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a.dataUrl} alt={`AI walls for ${labelOf.get(a.roomId)}`} style={{ width: "100%", borderRadius: 8, display: "block" }} />
                      <figcaption className="small muted">
                        {labelOf.get(a.roomId)}
                        {a.imagined && " · imagined"}
                      </figcaption>
                    </figure>
                  ))}
              </div>
            </details>
          )}
        </section>
      </div>
    </main>
  );
}
