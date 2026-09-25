"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useProject, useServerStatus } from "@/lib/client/project";
import { apiFetch } from "@/lib/client/access";
import { cached } from "@/lib/client/idb";
import { hashString } from "@/lib/client/hash";
import { beginRun, recordUsage } from "@/lib/client/cost";
import type { GeminiUsage } from "@/lib/cost";
import { estimateDepth, onModelProgress, type DepthEngine } from "@/lib/client/depth";
import { groupByRoom } from "@/lib/room-graph";
import { placementBatches, type Placement } from "@/lib/placement";
import { sortBatches, type SortPhotoInput, type SortResult } from "@/lib/sorting";
import { redrawImage } from "@/lib/client/images";
import { MATCH_CONFIDENCE_THRESHOLD, type PhotoMatch, type RoomGraph } from "@/lib/types";

const FloorPlanGraph = dynamic(() => import("@/components/FloorPlanGraph"), { ssr: false });
const CostNote = dynamic(() => import("@/components/CostNote"), { ssr: false });
const StereoTest = dynamic(() => import("@/components/StereoTest"), { ssr: false });
const CameraEditor = dynamic(() => import("@/components/CameraEditor"), { ssr: false });

type Busy = { label: string; done: number; total: number } | null;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { status: res.status });
  return json as T;
}

export default function AnalyzePage() {
  const { project, dispatch, photos, floorPlan, ready } = useProject();
  const status = useServerStatus();
  const [graphBusy, setGraphBusy] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [matchBusy, setMatchBusy] = useState<Busy>(null);
  const [matchErrors, setMatchErrors] = useState<Record<string, string>>({});
  const [placeBusy, setPlaceBusy] = useState<Busy>(null);
  const [sortNote, setSortNote] = useState<string | null>(null);
  const [placeErrors, setPlaceErrors] = useState<string[]>([]);
  const [depthBusy, setDepthBusy] = useState<Busy>(null);
  const [depthErrors, setDepthErrors] = useState<Record<string, string>>({});
  const [modelDl, setModelDl] = useState<number | null>(null);
  const [engineChoice, setEngine] = useState<DepthEngine | null>(null);
  const engine: DepthEngine = engineChoice ?? "browser";
  const [depthAbort, setDepthAbort] = useState<string | null>(null);
  const [testPhoto, setTestPhoto] = useState<string | null>(null);
  const [editCamera, setEditCamera] = useState<string | null>(null);

  useEffect(
    () =>
      onModelProgress((p) => {
        if (p.progress != null && p.file?.endsWith(".onnx")) setModelDl(p.progress >= 100 ? null : p.progress);
      }),
    [],
  );

  const graph = project.graph;
  const byId = useMemo(() => new Map(project.images.map((i) => [i.id, i])), [project.images]);

  async function runGraph() {
    if (!floorPlan) return;
    setGraphBusy(true);
    setGraphError(null);
    beginRun("graph");
    let fresh = false;
    try {
      const { raw, graph } = await cached(`graph:${floorPlan.id}`, async () => {
        const res = await postJson<{ raw: string; graph: RoomGraph; usage?: GeminiUsage }>("/api/room-graph", { floorPlan: floorPlan.dataUrl });
        fresh = true;
        recordUsage("graph", res.usage);
        return res;
      });
      if (!fresh) recordUsage("graph", null);
      console.log("[room-graph] raw Gemini output", raw);
      dispatch({ type: "graph", graph, raw, source: "gemini" });
    } catch (e) {
      setGraphError((e as Error).message);
    } finally {
      setGraphBusy(false);
    }
  }

  /**
   * Sort every photo in one call (per ≤36 photos), comparing them with each
   * other. Manual picks go along as fixed anchors and are never changed.
   */
  async function runSort(careful = false) {
    if (!graph) return;
    const graphKey = hashString(JSON.stringify(graph));
    const inputs = photos.map((p): SortPhotoInput => {
      const m = project.matches[p.id];
      // Listing captions help; uploaded filenames and demo labels would just leak or mislead.
      const label = p.source === "import" ? p.label : undefined;
      if (!m?.manual) return { id: p.id, label };
      return m.status === "exterior" ? { id: p.id, label, fixedExterior: true } : { id: p.id, label, fixedRoomId: m.roomId };
    });
    const batches = sortBatches(inputs);
    setMatchErrors({});
    setSortNote(null);
    beginRun("match");
    setMatchBusy({ label: "Sorting photos", done: 0, total: inputs.length });
    const context: string[] = [];
    let done = 0;
    for (const batch of batches) {
      let fresh = false;
      try {
        const key = `sort:${careful ? "pro" : "fast"}:${graphKey}:${hashString(JSON.stringify({ batch, context }))}`;
        const res = await cached(key, async () => {
          const [plan, ...shots] = await Promise.all([
            floorPlan ? redrawImage(floorPlan.dataUrl, 1600) : Promise.resolve(undefined),
            ...batch.map((p) => redrawImage(byId.get(p.id)!.dataUrl, 640)),
          ]);
          type Res = SortResult & { raw: string; usage?: GeminiUsage };
          const body = { graph, floorPlan: plan, context, careful, photos: batch.map((p, i) => ({ ...p, dataUrl: shots[i] })) };
          const r = await postJson<Res>("/api/sort-photos", body).catch((e: Error & { status?: number }) =>
            e.status == null || e.status >= 500 ? postJson<Res>("/api/sort-photos", body) : Promise.reject(e),
          );
          fresh = true;
          recordUsage("match", r.usage);
          console.log("[sort-photos]", r.raw);
          return r;
        });
        if (!fresh) recordUsage("match", null);
        for (const match of res.matches) {
          const prev = project.matches[match.photoId];
          // Same room as before: keep the camera placement, it's still valid.
          const keep = prev?.placed && prev.roomId === match.roomId;
          dispatch({
            type: "match",
            match: keep ? { ...match, headingDeg: prev.headingDeg, cameraPosition: prev.cameraPosition, placed: true, placementNote: prev.placementNote } : match,
          });
        }
        for (const [photoId, roomId] of Object.entries(res.disagreements)) {
          const prev = project.matches[photoId];
          if (prev && roomId) dispatch({ type: "match", match: { ...prev, suggestedRoomId: roomId } });
        }
        if (res.notes) setSortNote(res.notes);
        const label = (id: string | null) => graph.rooms.find((r) => r.id === id)?.label ?? "unsorted";
        for (const m of res.matches) context.push(`- ${label(m.roomId)}: ${m.appearance ?? "(no description)"}`);
      } catch (e) {
        for (const p of batch) setMatchErrors((m) => ({ ...m, [p.id]: (e as Error).message }));
      }
      done += batch.length;
      setMatchBusy({ label: "Sorting photos", done, total: inputs.length });
    }
    setMatchBusy(null);
  }

  /** Second pass: one Gemini call per room places all of its cameras together, using the room assignments as given. */
  async function runPlacement() {
    if (!graph || !floorPlan) return;
    const graphKey = hashString(JSON.stringify(graph));
    const jobs = graph.rooms.flatMap((room) =>
      placementBatches([...(groups[room.id] ?? [])].sort()).map((ids) => ({ room, ids })),
    );
    setPlaceErrors([]);
    beginRun("place");
    setPlaceBusy({ label: "Placing cameras", done: 0, total: jobs.length });
    let done = 0;
    const queue = [...jobs];
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const { room, ids } = job;
          let fresh = false;
          try {
            const fixedPose = (id: string) => {
              const m = project.matches[id];
              return m?.manualPose && m.cameraPosition && m.headingDeg != null ? { ...m.cameraPosition, headingDeg: m.headingDeg } : null;
            };
            const fixedKey = JSON.stringify(ids.map(fixedPose));
            const { placements } = await cached(`place:${graphKey}:${room.id}:${ids.join(",")}:${hashString(fixedKey)}`, async () => {
              // Smaller photos keep the request under the body limit; Gemini bills images per tile, not per pixel.
              const [plan, ...shots] = await Promise.all([
                redrawImage(floorPlan.dataUrl, 1600, room.bbox),
                ...ids.map((id) => redrawImage(byId.get(id)!.dataUrl, 1024)),
              ]);
              const body = { roomId: room.id, graph, floorPlan: plan, photos: ids.map((id, i) => ({ id, dataUrl: shots[i], fixedPose: fixedPose(id) })) };
              type Res = { raw: string; placements: Placement[]; usage?: GeminiUsage };
              // One retry: a multi-photo call is long enough that a dropped upstream connection happens.
              const res = await postJson<Res>("/api/place-photos", body).catch((e: Error & { status?: number }) =>
                e.status == null || e.status >= 500 ? postJson<Res>("/api/place-photos", body) : Promise.reject(e),
              );
              fresh = true;
              recordUsage("place", res.usage);
              console.log("[place-photos]", room.id, res.raw);
              return res;
            });
            if (!fresh) recordUsage("place", null);
            for (const placement of placements) dispatch({ type: "placement", roomId: room.id, placement });
          } catch (e) {
            const err = e as Error & { status?: number };
            setPlaceErrors((errs) => [...errs, `${room.label}: ${err.status === 504 ? "timed out" : err.message}`]);
          }
          setPlaceBusy({ label: "Placing cameras", done: ++done, total: jobs.length });
        }
      }),
    );
    setPlaceBusy(null);
  }

  async function runDepth() {
    const todo = photos.filter((p) => project.depth[p.id]?.source !== engine && project.matches[p.id]?.status !== "exterior");
    setDepthErrors({});
    setDepthBusy({ label: "Estimating depth", done: 0, total: todo.length });
    setDepthAbort(null);
    let done = 0, ok = 0, failed = 0;
    // Browser inference is serialized in the worker anyway; Replicate can go 3 at a time.
    const queue = [...todo];
    await Promise.all(
      Array.from({ length: engine === "replicate" ? 3 : 1 }, async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
          const photo = p;
          try {
            dispatch({ type: "depth", depth: await estimateDepth(photo, engine) });
            ok++;
          } catch (e) {
            setDepthErrors((m) => ({ ...m, [photo.id]: (e as Error).message }));
            // If nothing has worked yet, it's the engine (model download, missing key), not the photo: stop early.
            if (++failed >= 2 && ok === 0) {
              queue.length = 0;
              setDepthAbort((e as Error).message);
            }
          }
          setDepthBusy({ label: "Estimating depth", done: ++done, total: todo.length });
        }
      }),
    );
    setDepthBusy(null);
  }

  function assign(photoId: string, roomId: string) {
    const prev = project.matches[photoId];
    const status: PhotoMatch["status"] = roomId === "_exterior" ? "exterior" : roomId === "_none" ? "unmatched" : "matched";
    dispatch({
      type: "match",
      match: {
        photoId,
        roomId: roomId.startsWith("_") ? null : roomId,
        confidence: 1,
        // A manual move to a different room invalidates the model's camera guess.
        headingDeg: prev?.roomId === roomId ? prev.headingDeg : null,
        cameraPosition: prev?.roomId === roomId ? prev.cameraPosition : null,
        reasoning: "Assigned by you.",
        status,
        manual: true,
      },
    });
  }

  const groups = useMemo(() => groupByRoom(Object.values(project.matches).filter((m) => byId.has(m.photoId))), [project.matches, byId]);
  const unreviewed = photos.filter((p) => !project.matches[p.id]);
  const needsReview = Object.values(project.matches).filter((m) => byId.has(m.photoId) && (m.status === "low-confidence" || m.status === "unmatched"));
  const depthCount = photos.filter((p) => project.depth[p.id]).length;
  const roomsWithPhotos = (graph?.rooms ?? []).filter((r) => groups[r.id]?.length);
  const inRooms = Object.values(project.matches).filter((m) => byId.has(m.photoId) && m.roomId);
  const sortedCount = inRooms.length;
  const placedCount = inRooms.filter((m) => m.placed).length;
  const photoCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const [room, ids] of Object.entries(groups)) c[room] = ids.length;
    return c;
  }, [groups]);

  if (!ready) return <main className="shell"><p className="muted">Loading…</p></main>;
  if (!photos.length)
    return (
      <main className="shell">
        <h1>Analyze</h1>
        <p className="muted">
          No photos yet. <Link href="/">Add a listing or photos first</Link>.
        </p>
      </main>
    );

  const MatchCard = ({ m, photoId }: { m?: PhotoMatch; photoId: string }) => {
    const img = byId.get(photoId)!;
    const depth = project.depth[photoId];
    return (
      <div className="match">
        <div className="imgs">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={depth ? "" : "solo"} src={img.dataUrl} alt={img.label ?? ""} />
          {depth && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={depth.dataUrl} alt="depth map" />
          )}
        </div>
        <div className="meta">
          {m ? (
            <div className="row" style={{ gap: 4 }}>
              <span className={`badge ${m.status === "matched" ? "ok" : m.status === "low-confidence" ? "warn" : m.status === "exterior" ? "" : "bad"}`}>
                {m.manual ? "manual" : `${Math.round(m.confidence * 100)}%`}
              </span>
              {m.manualPose ? (
                <span className="badge ok" title="Camera set by you">camera set</span>
              ) : m.placed ? (
                <span className="badge ok" title={m.placementNote || "Placed on the plan"}>placed</span>
              ) : null}
              {m.headingDeg != null && (
                <span className="badge" title={`Camera faces ${Math.round(m.headingDeg)}° on the plan`}>
                  <span style={{ display: "inline-block", transform: `rotate(${m.headingDeg}deg)` }}>↑</span>
                </span>
              )}
            </div>
          ) : matchErrors[photoId] ? (
            <span className="badge bad" title={matchErrors[photoId]}>match failed</span>
          ) : null}
          {m?.appearance && <div className="small" style={{ fontSize: 11 }}>{m.appearance}</div>}
          {m?.reasoning && <div className="muted" style={{ fontSize: 11 }}>{m.reasoning}</div>}
          {m?.suggestedRoomId && graph?.rooms.some((r) => r.id === m.suggestedRoomId) && (
            <div className="notice small" style={{ padding: "4px 6px" }}>
              Gemini thinks this is the {graph.rooms.find((r) => r.id === m.suggestedRoomId)!.label}.{" "}
              <button className="linklike" onClick={() => assign(photoId, m.suggestedRoomId!)}>Move it</button>
            </div>
          )}
          {depthErrors[photoId] && <span className="badge bad" title={depthErrors[photoId]}>depth failed</span>}
          {graph && (
            <select
              aria-label="Room"
              value={m ? m.roomId ?? `_${m.status === "exterior" ? "exterior" : "none"}` : "_none"}
              onChange={(e) => assign(photoId, e.target.value)}
            >
              <option value="_none">Not sure / skip</option>
              <option value="_exterior">Exterior</option>
              {graph.rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
          <div className="row" style={{ gap: 6 }}>
            {depth && (
              <button className="btn small" onClick={() => setTestPhoto(photoId)}>
                View in 3D
              </button>
            )}
            {graph && floorPlan && m?.roomId && (
              <button className="btn small" onClick={() => setEditCamera(photoId)} title="Move or turn this photo's camera on the plan">
                Set camera
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <main className="shell">
      <h1>Analyze</h1>
      <p className="lede">Three steps: read the floor plan, sort photos into rooms, estimate depth. Results are cached on this device.</p>

      {/* Step 1 */}
      <section className="card">
        <div className="card-head">
          <h2>1 · Room map from floor plan</h2>
          {project.graphSource === "demo" && <span className="badge accent">demo ground truth</span>}
          {project.graphSource === "gemini" && <span className="badge ok">Gemini</span>}
        </div>
        {!floorPlan ? (
          <div className="notice info">
            No floor plan. You can still view each photo in 3D, but not walk between rooms. <Link href="/">Add one</Link>.
          </div>
        ) : (
          <>
            {status && !status.gemini && (
              <div className="notice" style={{ marginBottom: 10 }}>
                {status.access.ok ? (
                  <>Gemini isn&apos;t configured on the server (<code>GEMINI_API_KEY</code>).</>
                ) : (
                  <>AI steps are locked. <Link href="/">Unlock on the Listing page</Link> with the access password or your own Gemini key.</>
                )}
                {project.graphSource === "demo" ? " The demo house has a built-in room map." : " Room mapping is unavailable until it is."}
              </div>
            )}
            <div className="row">
              <button className="btn primary" onClick={runGraph} disabled={graphBusy || !status?.gemini}>
                {graphBusy ? <><span className="spinner" /> Reading plan…</> : graph && project.graphSource === "gemini" ? "Re-run" : "Read floor plan with Gemini"}
              </button>
              {status?.gemini && <span className="small muted">{status.geminiModel}</span>}
            </div>
            <CostNote action="graph" />
            {graphError && <div className="notice bad" style={{ marginTop: 10 }}>{graphError}</div>}
            {graph && (
              <>
                <p className="small muted">
                  {graph.rooms.length} rooms · {graph.rooms.reduce((n, r) => n + r.neighbors.length, 0) / 2} connections
                  {graph.notes ? ` · ${graph.notes}` : ""}
                </p>
                <div style={{ borderRadius: 10, overflow: "hidden", background: "var(--bg)" }}>
                  <FloorPlanGraph graph={graph} floorPlan={floorPlan} photoCounts={photoCounts} current={null} onSelect={() => {}} height={300} />
                </div>
                <details style={{ marginTop: 8 }}>
                  <summary>Raw output</summary>
                  <pre className="raw">{project.graphRaw}</pre>
                </details>
              </>
            )}
          </>
        )}
      </section>

      {/* Step 2 */}
      <section className="card">
        <div className="card-head">
          <h2>2 · Match photos to rooms</h2>
          {graph && <span className="small muted">{Object.keys(project.matches).length}/{photos.length} sorted</span>}
        </div>
        {!graph ? (
          <p className="muted small">Needs the room map from step 1.</p>
        ) : (
          <>
            <div className="row">
              <button className="btn primary" onClick={() => runSort()} disabled={!!matchBusy || !!placeBusy || !status?.gemini}>
                {matchBusy ? <><span className="spinner" /> {matchBusy.done}/{matchBusy.total}</> : Object.keys(project.matches).length ? "Re-check with Gemini" : "Sort with Gemini"}
              </button>
              <button
                className="btn small ghost"
                onClick={() => runSort(true)}
                disabled={!!matchBusy || !!placeBusy || !status?.gemini}
                title="Same comparison with the Pro model: slower and ~15× the cost, for look-alike rooms"
              >
                Careful (Pro)
              </button>
            </div>
            <p className="small muted">
              One call sorts every photo, comparing them with each other: listing order, wall colour, flooring, ceiling shape. Move
              photos by hand below, then re-check: your picks are kept, and Gemini uses them to sort the rest (and says if it disagrees).
              The quick sort uses Gemini Flash (about a cent); if rooms look alike, try <em>Careful</em> with Pro.
            </p>
            {sortNote && <div className="notice small">{sortNote}</div>}
            <CostNote action="match" />
            {matchBusy && <div className="progress"><div style={{ width: `${(100 * matchBusy.done) / Math.max(1, matchBusy.total)}%` }} /></div>}

            {roomsWithPhotos.length > 0 && (
              <div className="match-room">
                <h3>
                  Place cameras{" "}
                  <span className={`badge ${placedCount === sortedCount ? "ok" : ""}`}>{placedCount}/{sortedCount} placed</span>
                </h3>
                <p className="small muted" style={{ marginTop: 0 }}>
                  Second pass, after the rooms look right: Gemini looks at each room&apos;s photos together and works out where each
                  one was taken. This lines the photos up in 3D, and it restores camera positions for photos you moved by hand.{" "}
                  {floorPlan ? `One call per room (${roomsWithPhotos.length}); rooms you haven't changed come from cache.` : "Needs the floor plan."}
                </p>
                <button className="btn" onClick={runPlacement} disabled={!!placeBusy || !!matchBusy || !status?.gemini || !floorPlan}>
                  {placeBusy ? <><span className="spinner" /> {placeBusy.done}/{placeBusy.total} rooms</> : placedCount ? "Re-place cameras" : "Place cameras"}
                </button>
                <CostNote action="place" />
                {placedCount > 0 && graph && (
                  <div style={{ borderRadius: 10, overflow: "hidden", background: "var(--bg)", marginTop: 8 }}>
                    <FloorPlanGraph
                      graph={graph}
                      floorPlan={floorPlan}
                      photoCounts={photoCounts}
                      current={null}
                      onSelect={() => {}}
                      height={300}
                      cameras={inRooms
                        .filter((m) => m.placed && m.cameraPosition && m.headingDeg != null)
                        .map((m) => ({ ...m.cameraPosition!, headingDeg: m.headingDeg! }))}
                    />
                  </div>
                )}
                {placeBusy && <div className="progress"><div style={{ width: `${(100 * placeBusy.done) / Math.max(1, placeBusy.total)}%` }} /></div>}
                {placeErrors.length > 0 && (
                  <div className="notice bad small" style={{ marginTop: 8 }}>
                    {placeErrors.join(" · ")}. Tap <strong>Re-place cameras</strong> to retry: rooms that finished come from cache, so
                    only the failed ones are re-sent.
                  </div>
                )}
              </div>
            )}
            {needsReview.length > 0 && (
              <div className="match-room">
                <h3>
                  Needs a look <span className="badge warn">{needsReview.length}</span>
                </h3>
                <p className="small muted" style={{ marginTop: 0 }}>
                  Gemini wasn&apos;t sure (below {Math.round(MATCH_CONFIDENCE_THRESHOLD * 100)}%) or couldn&apos;t place these. Low-confidence
                  photos still appear in their best-guess room; unplaced ones are left out of the tour until you pick a room.
                </p>
                <div className="match-list">
                  {needsReview.map((m) => <MatchCard key={m.photoId} m={m} photoId={m.photoId} />)}
                </div>
              </div>
            )}
            {graph.rooms.map((r) => (
              <div key={r.id} className="match-room">
                <h3>
                  {r.label} <span className="badge">{groups[r.id]?.length ?? 0}</span>
                  {(groups[r.id]?.length ?? 0) >= 2 && <span className="badge accent" style={{ marginLeft: 6 }}>multi-photo</span>}
                </h3>
                {groups[r.id]?.length ? (
                  <div className="match-list">
                    {groups[r.id].map((id) => <MatchCard key={id} m={project.matches[id]} photoId={id} />)}
                  </div>
                ) : (
                  <p className="small muted" style={{ margin: 0 }}>No photos. This room will show on the map without a view.</p>
                )}
              </div>
            ))}
            {(groups._exterior?.length ?? 0) > 0 && (
              <div className="match-room">
                <h3>Exterior <span className="badge">{groups._exterior.length}</span></h3>
                <div className="match-list">{groups._exterior.map((id) => <MatchCard key={id} m={project.matches[id]} photoId={id} />)}</div>
              </div>
            )}
            {unreviewed.length > 0 && (
              <div className="match-room">
                <h3>Not sorted yet <span className="badge">{unreviewed.length}</span></h3>
                <div className="match-list">{unreviewed.map((p) => <MatchCard key={p.id} photoId={p.id} />)}</div>
              </div>
            )}
          </>
        )}
      </section>

      {/* Step 3 */}
      <section className="card">
        <div className="card-head">
          <h2>3 · Depth</h2>
          <span className="small muted">{depthCount}/{photos.length} photos</span>
        </div>
        <div className="row">
          <select className="input grow" style={{ maxWidth: "100%" }} value={engine} onChange={(e) => setEngine(e.target.value as DepthEngine)}>
            <option value="browser">On device · Depth Anything V2 small</option>
            <option value="replicate" disabled={!status?.replicate}>
              Server · Depth Anything V2 large{status && !status.replicate ? " (needs Replicate)" : ""}
            </option>
            <option value="heuristic">Quick guess · box-room shape</option>
            {project.isDemo && <option value="truth">Demo · exact depth</option>}
          </select>
          <button className="btn primary" onClick={runDepth} disabled={!!depthBusy}>
            {depthBusy ? <><span className="spinner" /> {depthBusy.done}/{depthBusy.total}</> : "Estimate depth"}
          </button>
        </div>
        {engine === "browser" && (
          <p className="small muted">
            Runs privately on your device (WebGPU if available). The first run downloads a ~27 MB model, which is cached after that.
          </p>
        )}
        {modelDl != null && <div className="small muted">Downloading model… {Math.round(modelDl)}%</div>}
        {depthBusy && <div className="progress"><div style={{ width: `${(100 * depthBusy.done) / Math.max(1, depthBusy.total)}%` }} /></div>}
        {depthAbort ? (
          <div className="notice bad" style={{ marginTop: 10 }}>
            Depth engine isn&apos;t working here ({depthAbort}). {engine === "browser"
              ? "The model download may be blocked by your network, or the device may be out of memory. "
              : ""}
            Try another option above. &ldquo;Quick guess&rdquo; always works.
          </div>
        ) : Object.keys(depthErrors).length > 0 && (
          <div className="notice bad" style={{ marginTop: 10 }}>
            {Object.keys(depthErrors).length} photo(s) failed: {Object.values(depthErrors)[0]}
          </div>
        )}
        {!graph && depthCount > 0 && (
          <div className="match-list" style={{ marginTop: 12 }}>
            {photos.map((p) => <MatchCard key={p.id} photoId={p.id} />)}
          </div>
        )}
      </section>

      <div className="row" style={{ justifyContent: "space-between" }}>
        <Link className="btn ghost" href="/">← Listing</Link>
        {graph && (
          <Link className="btn" href="/flythrough" title="Optional: the whole house as a 3D model, with a guided flight through it">
            3D fly-through
          </Link>
        )}
        {graph && (
          <Link className="btn" href="/dollhouse" title="Optional: the whole house as a 3D model to spin and zoom">
            Dollhouse
          </Link>
        )}
        <Link
          className="btn primary"
          href="/tour"
          aria-disabled={!depthCount}
          onClick={(e) => !depthCount && e.preventDefault()}
          style={!depthCount ? { opacity: 0.45 } : undefined}
        >
          Start tour →
        </Link>
      </div>

      {editCamera && graph && byId.get(editCamera) && project.matches[editCamera] && (
        <CameraEditor
          graph={graph}
          floorPlan={floorPlan}
          photo={byId.get(editCamera)!}
          match={project.matches[editCamera]}
          onClose={() => setEditCamera(null)}
          onSave={(pose) => {
            dispatch({ type: "match", match: { ...project.matches[editCamera], ...pose, manualPose: true, placed: true } });
            setEditCamera(null);
          }}
        />
      )}
      {testPhoto && byId.get(testPhoto) && project.depth[testPhoto] && (
        <StereoTest photo={byId.get(testPhoto)!} depth={project.depth[testPhoto]} onClose={() => setTestPhoto(null)} />
      )}
    </main>
  );
}
