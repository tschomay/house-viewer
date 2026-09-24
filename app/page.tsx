"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type DragEvent } from "react";
import { useProject, useServerStatus } from "@/lib/client/project";
import { apiFetch } from "@/lib/client/access";
import AccessPanel from "@/components/AccessPanel";
import BookmarkletCard from "@/components/BookmarkletCard";
import { bookmarkletImportResult, parseBookmarkletHash } from "@/lib/bookmarklet";
import { importRemoteImage, toListingImage } from "@/lib/client/images";
import { buildDemo, DEMO_LISTING_LABEL } from "@/lib/client/demo";
import { exportProject, readProjectFile } from "@/lib/client/project-file";
import type { ImportResult, ListingImage } from "@/lib/types";

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = { status: "fulfilled", value: await fn(items[i]) };
        } catch (reason) {
          out[i] = { status: "rejected", reason };
        }
      }
    }),
  );
  return out;
}

export default function IntakePage() {
  const { project, dispatch, photos, floorPlan, ready } = useProject();
  const status = useServerStatus();
  const locked = status ? !status.access.ok : false;
  const router = useRouter();
  const [importing, setImporting] = useState<null | { done: number; total: number }>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [demoProgress, setDemoProgress] = useState<string | null>(null);
  const [over, setOver] = useState<"photo" | "floorplan" | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  // An import handed over by the bookmarklet (in the URL hash), waiting for the project to load and access to unlock.
  const [pending, setPending] = useState<ImportResult | null>(null);

  useEffect(() => {
    const payload = parseBookmarkletHash(window.location.hash);
    if (!payload) return;
    queueMicrotask(() => setPending(bookmarkletImportResult(payload)));
  }, []);

  async function runImport() {
    setImportNote(null);
    setImporting({ done: 0, total: 0 });
    let result: ImportResult;
    try {
      const res = await apiFetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: project.listingInput }),
      });
      result = await res.json();
      if (!res.ok) result = { ok: false, steps: [], photos: [], floorPlans: [], error: (result as { error?: string }).error };
    } catch (e) {
      result = { ok: false, steps: [], photos: [], floorPlans: [], error: (e as Error).message };
    }
    await downloadImages(result);
  }

  async function downloadImages(result: ImportResult) {
    setImportNote(null);
    dispatch({ type: "import", result });
    const todo = [
      ...result.floorPlans.map((f) => ({ ...f, kind: "floorplan" as const })),
      ...result.photos.map((p) => ({ ...p, kind: "photo" as const })),
    ];
    setImporting({ done: 0, total: todo.length });
    let done = 0;
    const settled = await mapLimit(todo, 4, async (t) => {
      const img = await importRemoteImage(t.url, t.kind, t.alt);
      dispatch({ type: "addImages", images: [img] });
      setImporting({ done: ++done, total: todo.length });
      return img;
    });
    const failed = settled.filter((s) => s.status === "rejected").length;
    if (failed) setImportNote(`${failed} of ${todo.length} images couldn't be downloaded (the image host may block us).`);
    setImporting(null);
  }

  useEffect(() => {
    if (!pending || !ready || !status?.access.ok) return;
    const result = pending;
    // Drop the hash only now, so reloading while still locked doesn't lose the list.
    history.replaceState(null, "", window.location.pathname + window.location.search);
    queueMicrotask(() => {
      setPending(null);
      // A bookmarklet import starts a new listing.
      dispatch({ type: "reset" });
      dispatch({ type: "input", value: result.resolvedUrl ?? "" });
      void downloadImages(result);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- downloadImages is recreated each render; this runs once per pending import
  }, [pending, ready, status]);

  async function addFiles(files: FileList | File[] | null, kind: ListingImage["kind"]) {
    if (!files) return;
    setAddError(null);
    const list = [...files].filter((f) => f.type.startsWith("image/"));
    const results = await mapLimit(list, 3, (f) => toListingImage(f, kind, "upload", { label: f.name }));
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    // Only one floor plan drives the room graph; demote any previous one.
    if (kind === "floorplan" && floorPlan && ok.length) dispatch({ type: "setKind", id: floorPlan.id, kind: "photo" });
    dispatch({ type: "addImages", images: kind === "floorplan" ? ok.slice(0, 1) : ok });
    const bad = results.length - ok.length + (files.length - list.length);
    if (bad) setAddError(`${bad} file(s) couldn't be read as images (HEIC isn't supported by every browser; try JPEG).`);
  }

  async function loadDemo() {
    setDemoProgress("Rendering demo house…");
    try {
      const demo = await buildDemo((d, t) => setDemoProgress(`Rendering photo ${d} of ${t}…`));
      dispatch({ type: "reset" });
      dispatch({
        type: "replace",
        project: {
          listingInput: DEMO_LISTING_LABEL,
          images: demo.images,
          graph: demo.graph,
          graphRaw: JSON.stringify(demo.graph, null, 2),
          graphSource: "demo",
          matches: Object.fromEntries(demo.matches.map((m) => [m.photoId, m])),
          isDemo: true,
        },
      });
      router.push("/analyze");
    } catch (e) {
      setDemoProgress(`Demo failed: ${(e as Error).message}`);
      return;
    }
    setDemoProgress(null);
  }

  const drop = (kind: "photo" | "floorplan") => ({
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setOver(kind);
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(null);
      void addFiles(e.dataTransfer.files, kind);
    },
  });

  const ir = project.importResult;

  return (
    <main className="shell">
      <h1>Tour a house in 3D, from its listing</h1>
      <p className="lede">
        Paste a listing, add the photos and floor plan, and walk room to room in stereoscopic 3D. No headset: hold your phone
        close and cross your eyes.
      </p>
      <div className="row" style={{ marginTop: -8 }}>
        <button className="btn" onClick={loadDemo} disabled={!!demoProgress || !ready}>
          {demoProgress ? <><span className="spinner" /> {demoProgress}</> : "Try the demo house"}
        </button>
        <span className="small muted">No listing handy? A small synthetic house, no sign-in needed.</span>
      </div>

      <AccessPanel status={status} />

      <section className="card">
        <div className="card-head">
          <h2>Import from a listing</h2>
          <span className="badge warn">best effort</span>
        </div>
        <div className="row">
          <input
            className="input grow"
            placeholder="Listing URL or street address"
            value={project.listingInput}
            onChange={(e) => dispatch({ type: "input", value: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && project.listingInput.trim() && !importing && !locked && runImport()}
            inputMode="url"
            autoComplete="off"
          />
          <button className="btn primary" disabled={!project.listingInput.trim() || !!importing || locked} onClick={runImport}>
            {importing ? <span className="spinner" /> : null} Import
          </button>
        </div>
        {locked && <p className="small muted">Unlock above to use auto-import.</p>}
        {pending && (
          <div className="notice info" style={{ marginTop: 8 }}>
            The bookmarklet sent {pending.photos.length} photo{pending.photos.length === 1 ? "" : "s"}
            {pending.floorPlans.length ? ` and ${pending.floorPlans.length} floor plan${pending.floorPlans.length === 1 ? "" : "s"}` : ""}.
            {locked ? " Unlock above and they'll download." : " Downloading…"}
          </div>
        )}
        <p className="small muted" style={{ marginBottom: 0 }}>
          Auto-import often fails: Zillow, Redfin and others block automated requests, and page layouts change. You can always
          add photos and the floor plan yourself below.
        </p>
        {importing && importing.total > 0 && (
          <div className="progress" aria-label="import progress">
            <div style={{ width: `${(100 * importing.done) / importing.total}%` }} />
          </div>
        )}
        {ir && !importing && (
          <div style={{ marginTop: 12 }}>
            {ir.ok ? (
              <div className="notice ok">
                Found {ir.photos.length} photo{ir.photos.length === 1 ? "" : "s"}
                {ir.floorPlans.length ? ` and ${ir.floorPlans.length} floor plan${ir.floorPlans.length === 1 ? "" : "s"}` : ", but no floor plan"}.
                {!ir.floorPlans.length && " Add the floor plan below (realtors can usually send one)."}
              </div>
            ) : (
              <div className="notice bad">
                <div>
                  <strong>Couldn&apos;t import automatically.</strong> {ir.error} Use the manual upload below instead.
                </div>
              </div>
            )}
            {importNote && <div className="notice" style={{ marginTop: 8 }}>{importNote}</div>}
            {ir.steps.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary>What we tried</summary>
                <ul className="steplog">
                  {ir.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </section>

      <BookmarkletCard />

      <section className="card">
        <div className="card-head">
          <h2>Add photos yourself</h2>
          <span className="badge">always available</span>
        </div>
        <p className="small muted" style={{ marginTop: 0 }}>
          Add extra shots your realtor sent, or everything if import failed. Several photos of the same room from different
          corners give a fuller 3D shape.
        </p>
        <div className="row" style={{ alignItems: "stretch" }}>
          <label className={`drop grow ${over === "floorplan" ? "over" : ""}`} {...drop("floorplan")}>
            <strong style={{ color: "var(--text)" }}>Floor plan</strong>
            <div className="small">{floorPlan ? "✓ added (drop to replace)" : "Tap or drop one image"}</div>
            <input type="file" accept="image/*" hidden onChange={(e) => addFiles(e.target.files, "floorplan")} />
          </label>
          <label className={`drop grow ${over === "photo" ? "over" : ""}`} {...drop("photo")}>
            <strong style={{ color: "var(--text)" }}>Room photos</strong>
            <div className="small">Tap or drop any number</div>
            <input type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.target.files, "photo")} />
          </label>
        </div>
        {addError && <div className="notice bad" style={{ marginTop: 10 }}>{addError}</div>}
      </section>

      {project.images.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>
              {photos.length} photo{photos.length === 1 ? "" : "s"} · {floorPlan ? "floor plan ✓" : "no floor plan yet"}
            </h2>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn small ghost" onClick={() => exportProject(project)} title="Save photos, rooms and camera placements as one file">
                Export
              </button>
              <button className="btn small ghost" onClick={() => confirm("Remove all images and results?") && dispatch({ type: "reset" })}>
                Start over
              </button>
            </div>
          </div>
          <div className="gallery">
            {[...project.images]
              .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "floorplan" ? -1 : 1))
              .map((img) => (
                <div key={img.id} className={`thumb ${img.kind === "floorplan" ? "plan" : ""}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.dataUrl} alt={img.label ?? ""} />
                  <button className="x" aria-label="Remove" onClick={() => dispatch({ type: "removeImage", id: img.id })}>
                    ×
                  </button>
                  <button
                    className="kind"
                    onClick={() => {
                      if (img.kind === "photo" && floorPlan) dispatch({ type: "setKind", id: floorPlan.id, kind: "photo" });
                      dispatch({ type: "setKind", id: img.id, kind: img.kind === "photo" ? "floorplan" : "photo" });
                    }}
                  >
                    {img.kind === "floorplan" ? "★ Floor plan" : img.source === "import" ? "Imported · set as plan" : "Set as plan"}
                  </button>
                </div>
              ))}
          </div>
        </section>
      )}

      <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
        <Link
          className="btn primary"
          href="/analyze"
          aria-disabled={!photos.length}
          onClick={(e) => !photos.length && e.preventDefault()}
          style={!photos.length ? { opacity: 0.45 } : undefined}
        >
          Continue →
        </Link>
      </div>
      <p className="small muted" style={{ marginTop: 16 }}>
        Have a project file from <strong>Export</strong>?{" "}
        <label className="linklike" style={{ cursor: "pointer" }}>
          Import it
          <input
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                const imported = await readProjectFile(file);
                if (project.images.length && !confirm("Replace the current project with the imported one?")) return;
                dispatch({ type: "load", project: imported });
                setAddError(null);
              } catch (err) {
                setAddError((err as Error).message);
              }
            }}
          />
        </label>
        {" "}(photos, rooms and camera placements; depth is recomputed).
      </p>
      {!floorPlan && photos.length > 0 && (
        <p className="small muted">Without a floor plan you can still view each photo in 3D, but not walk between rooms.</p>
      )}
    </main>
  );
}
