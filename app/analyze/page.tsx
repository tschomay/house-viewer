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
import { MATCH_CONFIDENCE_THRESHOLD, type PhotoMatch, type RoomGraph } from "@/lib/types";

const FloorPlanGraph = dynamic(() => import("@/components/FloorPlanGraph"), { ssr: false });
const CostNote = dynamic(() => import("@/components/CostNote"), { ssr: false });
const StereoTest = dynamic(() => import("@/components/StereoTest"), { ssr: false });

type Busy = { label: string; done: number; total: number } | null;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export default function AnalyzePage() {
  const { project, dispatch, photos, floorPlan, ready } = useProject();
  const status = useServerStatus();
  const [graphBusy, setGraphBusy] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [matchBusy, setMatchBusy] = useState<Busy>(null);
  const [matchErrors, setMatchErrors] = useState<Record<string, string>>({});
  const [depthBusy, setDepthBusy] = useState<Busy>(null);
  const [depthErrors, setDepthErrors] = useState<Record<string, string>>({});
  const [modelDl, setModelDl] = useState<number | null>(null);
  const [engineChoice, setEngine] = useState<DepthEngine | null>(null);
  const engine: DepthEngine = engineChoice ?? "browser";
  const [depthAbort, setDepthAbort] = useState<string | null>(null);
  const [testPhoto, setTestPhoto] = useState<string | null>(null);

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

  async function runMatching() {
    if (!graph) return;
    const graphKey = hashString(JSON.stringify(graph));
    const todo = photos.filter((p) => !project.matches[p.id]?.manual);
    setMatchErrors({});
    beginRun("match");
    setMatchBusy({ label: "Matching photos to rooms", done: 0, total: todo.length });
    let done = 0;
    const queue = [...todo];
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
          const photo = p;
          let fresh = false;
          try {
            const { raw, match } = await cached(`match:${graphKey}:${photo.id}`, async () => {
              const res = await postJson<{ raw: string; match: PhotoMatch; usage?: GeminiUsage }>("/api/match-photo", {
                photoId: photo.id,
                photo: photo.dataUrl,
                graph,
                floorPlan: floorPlan?.dataUrl,
              });
              fresh = true;
              recordUsage("match", res.usage);
              return res;
            });
            if (!fresh) recordUsage("match", null);
            dispatch({ type: "match", match, raw });
          } catch (e) {
            setMatchErrors((m) => ({ ...m, [photo.id]: (e as Error).message }));
          }
          setMatchBusy({ label: "Matching photos to rooms", done: ++done, total: todo.length });
        }
      }),
    );
    setMatchBusy(null);
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
              {m.headingDeg != null && (
                <span className="badge" title={`Camera faces ${Math.round(m.headingDeg)}° on the plan`}>
                  <span style={{ display: "inline-block", transform: `rotate(${m.headingDeg}deg)` }}>↑</span>
                </span>
              )}
            </div>
          ) : matchErrors[photoId] ? (
            <span className="badge bad" title={matchErrors[photoId]}>match failed</span>
          ) : null}
          {m?.reasoning && <div className="muted" style={{ fontSize: 11 }}>{m.reasoning}</div>}
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
          {depth && (
            <button className="btn small" onClick={() => setTestPhoto(photoId)}>
              View in 3D
            </button>
          )}
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
              <button className="btn primary" onClick={runMatching} disabled={!!matchBusy || !status?.gemini}>
                {matchBusy ? <><span className="spinner" /> {matchBusy.done}/{matchBusy.total}</> : Object.keys(project.matches).length ? "Re-match with Gemini" : "Match with Gemini"}
              </button>
              <span className="small muted">Or pick rooms by hand below. Manual picks are kept on re-runs.</span>
            </div>
            <CostNote action="match" />
            {matchBusy && <div className="progress"><div style={{ width: `${(100 * matchBusy.done) / Math.max(1, matchBusy.total)}%` }} /></div>}

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

      {testPhoto && byId.get(testPhoto) && project.depth[testPhoto] && (
        <StereoTest photo={byId.get(testPhoto)!} depth={project.depth[testPhoto]} onClose={() => setTestPhoto(null)} />
      )}
    </main>
  );
}
