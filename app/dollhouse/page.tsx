"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DollhouseView } from "@/components/HouseDollhouse";
import { roomPalette } from "@/lib/client/house-palette";
import type { RoomColors } from "@/lib/client/house-scene";
import { usePref } from "@/lib/client/prefs";
import { useProject } from "@/lib/client/project";
import { buildHouseModel, floorName, type HouseModel } from "@/lib/house-model";

const HouseDollhouse = dynamic(() => import("@/components/HouseDollhouse"), { ssr: false });

/** Floors in model.floors order, sorted bottom to top for the picker. */
function floorsBottomUp(model: HouseModel) {
  return model.floors
    .map((f, i) => ({ i, name: floorName(f.level, model.floors.length), elevation: f.elevation, rooms: model.rooms.filter((r) => r.floor === i && !r.parent) }))
    .sort((a, b) => a.elevation - b.elevation);
}

export default function DollhousePage() {
  const { project, photos, floorPlan, ready } = useProject();
  const [floor, setFloor] = useState<number | null>(null);
  const [wallCut, setWallCut] = usePref<number>("dollWallCut", 1);
  const [siding, setSiding] = usePref<boolean>("dollSiding", false);
  const [labels, setLabels] = usePref<boolean>("dollLabels", true);
  const [autoRotate, setAutoRotate] = useState(false);
  const [focus, setFocus] = useState<{ roomId: string | null; n: number }>({ roomId: null, n: 0 });
  const [view, setView] = useState<{ kind: DollhouseView; n: number }>({ kind: "reset", n: 0 });
  const [full, setFull] = useState(false);
  const [palette, setPalette] = useState<Record<string, RoomColors> | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const photosById = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const aspect = floorPlan ? floorPlan.width / floorPlan.height : 1;
  const model = useMemo(() => (project.graph ? buildHouseModel(project.graph, aspect, project.matches) : null), [project.graph, aspect, project.matches]);
  const floors = useMemo(() => (model ? floorsBottomUp(model) : []), [model]);
  const wallArt = useMemo(() => project.wallArt ?? {}, [project.wallArt]);
  const focusRoom = focus.roomId ? model?.rooms.find((r) => r.id === focus.roomId) : null;

  useEffect(() => {
    if (!model) return;
    let alive = true;
    void roomPalette(model, photosById).then((p) => alive && setPalette(p));
    return () => {
      alive = false;
    };
  }, [model, photosById]);

  const move = useCallback((kind: DollhouseView) => setView((v) => ({ kind, n: v.n + 1 })), []);
  const pickRoom = useCallback(
    (roomId: string) => {
      const r = model?.rooms.find((x) => x.id === roomId);
      if (!r) return;
      // Picking a room on another floor switches to that floor, so nothing above hides it.
      const top = floor == null ? floors[floors.length - 1]?.i : floor;
      if (r.floor !== top) setFloor(r.floor);
      setAutoRotate(false);
      setFocus((f) => ({ roomId, n: f.n + 1 }));
    },
    [model, floor, floors],
  );
  const onInteract = useCallback(() => setAutoRotate(false), []);

  // Keyboard: PageUp/PageDown change floor, +/− zoom, 0 or Home resets, T looks from the top.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea")) return;
      const at = floor == null ? floors.length - 1 : floors.findIndex((f) => f.i === floor);
      if (e.key === "PageUp" && at < floors.length - 1) setFloor(at + 1 === floors.length - 1 ? null : floors[at + 1].i);
      else if (e.key === "PageDown" && at > 0) setFloor(floors[at - 1].i);
      else if (e.key === "+" || e.key === "=") move("in");
      else if (e.key === "-") move("out");
      else if (e.key === "0" || e.key === "Home") move("reset");
      else if (e.key === "t" || e.key === "T") move("top");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [floor, floors, move]);

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
  if (!model || !model.rooms.length)
    return (
      <main className="shell">
        <h1>Dollhouse</h1>
        <p className="muted">
          The dollhouse is a 3D model of the whole house built from the floor plan&apos;s room map. Read the floor plan on the{" "}
          <Link href="/analyze">Analyze</Link> page first; sort the photos and place the cameras there to paint the rooms with them.
        </p>
      </main>
    );

  const placed = model.rooms.reduce((n, r) => n + r.photos.length, 0);
  const shownRooms = floor == null ? floors.flatMap((f) => f.rooms) : floors.filter((f) => f.elevation <= model.floors[floor].elevation).flatMap((f) => f.rooms);

  return (
    <main className="tour">
      <div ref={stageRef} className={`stage doll ${full ? "full" : ""}`}>
        {palette ? (
          <HouseDollhouse
            model={model}
            photos={photosById}
            wallArt={wallArt}
            palette={palette}
            floor={floor}
            wallCut={wallCut}
            siding={siding}
            labels={labels}
            autoRotate={autoRotate}
            focus={focus}
            view={view}
            onPickRoom={pickRoom}
            onInteract={onInteract}
          />
        ) : (
          <div className="center-msg"><span className="spinner" /></div>
        )}
        <div className="stage-title">{focusRoom?.label ?? ""}</div>
        {floors.length > 1 && (
          <div className="doll-floors" role="group" aria-label="Floor">
            {[...floors].reverse().map((f, k) => {
              const all = k === 0;
              const on = all ? floor == null || floor === f.i : floor === f.i;
              return (
                <button key={f.i} aria-pressed={on} onClick={() => setFloor(all ? null : f.i)} title={all ? `${f.name} (whole house)` : `${f.name}: hide the floors above`}>
                  {f.name}
                </button>
              );
            })}
          </div>
        )}
        <div className="stage-tools doll-zoom">
          <button className="btn small" onClick={() => move("in")} aria-label="Zoom in">+</button>
          <button className="btn small" onClick={() => move("out")} aria-label="Zoom out">−</button>
        </div>
        <div className="stage-tools" style={{ top: 8, bottom: "auto" }}>
          <button className="btn small" onClick={() => move("reset")} title="Back to the whole-house view (0)">⟲</button>
          <button className="btn small" onClick={() => move("top")} title="Look straight down, like the floor plan (T)">Top</button>
          <button className="btn small" onClick={() => setAutoRotate((a) => !a)} aria-pressed={autoRotate} title="Spin slowly">
            {autoRotate ? "Spin ✓" : "Spin"}
          </button>
          <button className="btn small" onClick={toggleFull}>{full ? "Exit" : "⤢"}</button>
        </div>
      </div>

      <div className="controls">
        <div className="row small" style={{ gap: 14, flexWrap: "wrap" }}>
          <label className="row" style={{ gap: 6 }} title="Cut the walls down to see into the rooms">
            Walls
            <input type="range" min={0.15} max={1} step={0.05} value={wallCut} onChange={(e) => setWallCut(Number(e.target.value))} aria-label="Wall height" />
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={siding} onChange={(e) => setSiding(e.target.checked)} /> outside walls
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> room names
          </label>
        </div>
        <div className="chips" aria-label="Rooms">
          {shownRooms.map((r) => (
            <button key={r.id} className={`chip ${focus.roomId === r.id ? "" : "dim"}`} onClick={() => pickRoom(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Drag to spin, pinch or scroll to zoom, two fingers or right-drag to move. Tap a room name (or double-tap a room) to go to it.
          {floors.length > 1 && " Pick a floor to lift off the ones above."} Keys: PgUp/PgDn floors, +/− zoom, 0 reset, T top.
        </p>
      </div>

      <div className="shell" style={{ paddingTop: 12, width: "100%" }}>
        <section className="card">
          <div className="card-head">
            <h2>Dollhouse <span className="badge accent">beta</span></h2>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {model.rooms.filter((r) => !r.parent).length} rooms on {model.floors.length} floor{model.floors.length === 1 ? "" : "s"}, built from the floor plan and
            painted with <strong>{placed}</strong> placed photo{placed === 1 ? "" : "s"}
            {Object.keys(wallArt).length > 0 && " and the AI wall fill"}. Rooms without photos show paint colours. For a guided walk through it, see the{" "}
            <Link href="/flythrough">fly-through</Link>.
          </p>
        </section>
      </div>
    </main>
  );
}
