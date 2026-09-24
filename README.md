# House Viewer

A phone-first web app that turns a real-estate listing's photos and floor plan into a room-by-room **stereoscopic tour**. Hold the phone close and cross your eyes; no headset needed.

```
Listing (URL / address / manual upload)
   │
   ├─ floor plan ──▶ Gemini ──▶ room graph (rooms, adjacency, centroids, bounds, sizes)
   │                                 │
   ├─ all photos ──▶ Gemini (one call) ┴─▶ room for each photo, judged by comparing them
   │                 (listing order, wall colour, flooring, ceiling; your manual picks as anchors)
   │
   ├─ each room's photos ──▶ Gemini (one call per room) ──▶ joint camera placement
   │                         (after you've fixed the room assignments)
   │
   ├─ each photo ──▶ Depth Anything V2 ──▶ relative depth map
   │                (on-device, or Replicate)
   │
   └─ per room: depth → metric (floor fit) → 3D mesh; 2+ photos → plan pose,
                snapped to the plan's room outline, then a small ICP nudge
                     │
                     ▼
        Three.js: floor-plan node graph ⇄ stereo room view (cross-eye / parallel / wiggle / flat)
                  + gyro parallax + crossfade/dolly transitions
```

## Try it

```bash
npm install
npm run dev          # http://localhost:3000
```

Tap **Try the demo house**. It renders a small synthetic house in your browser, with a floor plan, 9 photos and a ground-truth room map, so the whole tour works with **no API keys**. The demo also offers an "exact depth" engine that renders true depth. Use it to check that the geometry (merge, stereo, camera conventions) is right separately from the depth model's quality.

Other checks:

```bash
npm test             # vitest: parser, room graph, geometry, ICP merge
npm run typecheck
npm run lint
node scripts/e2e-demo.mjs http://localhost:3000 e2e-shots   # headless phone-sized run with screenshots
DEPTH_ENGINE=truth node scripts/e2e-demo.mjs ...             # same, with exact depth
```

## Configuration

Copy `.env.example` → `.env.local` (or set these in Vercel → Project → Settings → Environment Variables):

| Variable | Needed for | Notes |
|---|---|---|
| `ACCESS_PASSWORD` | the gate | Visitors who enter it use *your* keys below. |
| `GEMINI_API_KEY` | floor plan → room graph, photo → room | Default model `gemini-3.1-pro-preview`; override with `GEMINI_MODEL`. |
| `REPLICATE_API_TOKEN` | optional server-side depth | Depth Anything V2 **Large** (`chenxwh/depth-anything-v2`, version pinned). |

### Access gate (why the public deployment won't burn your credits)

Every server route that costs money or fetches arbitrary URLs (`/api/room-graph`, `/api/sort-photos`, `/api/match-photo`, `/api/place-photos`, `/api/depth`, `/api/import`, `/api/proxy-image`) needs one of:

1. **The access password** (`x-access-password` header, entered on the Listing page). This unlocks the server's keys.
2. **The visitor's own Gemini key** (`x-gemini-key`). The server checks it with Google once (then caches the result for 30 minutes) and uses it for that visitor only. A Replicate token can come with it.

With neither, those routes return 401. In `next dev` with no `ACCESS_PASSWORD` set, the gate is open for convenience. Credentials live only in the visitor's `localStorage`. The demo house and on-device depth never touch the gated routes.

## How it works

| Stage | Where | Notes |
|---|---|---|
| Auto-import | `lib/importer.ts`, `lib/listing-parse.ts` | Fetches the page server-side and pulls images from JSON-LD, `og:image`, `<img>` and inline JSON blobs. Keeps the largest size of each photo and flags floor plans by caption or URL. An address goes through Redfin's autocomplete. Blocks and CAPTCHAs return a readable reason, and the UI falls through to manual upload. SSRF-guarded (`lib/safe-fetch.ts`). |
| Room graph | `lib/gemini.ts`, `lib/room-graph.ts` | Structured JSON output with a schema. Normalization dedupes ids, clamps coordinates, drops unknown neighbours, and makes adjacency symmetric. The raw output is logged and shown on the Analyze page. |
| Photo sorting | `lib/sorting.ts`, `app/api/sort-photos/route.ts` | **One call for the whole listing** (≤36 photos per call; bigger listings go in batches, with earlier batches summarized as text). Photos go at 640 px and Gemini's medium media resolution, in listing order, with listing captions. Gemini compares them with each other (consecutive photos, wall colour, flooring, ceiling shape, fixtures) to group, split and match them. It returns a room, a confidence, a short **appearance** note shown on each card, and its reasoning. Manual picks go along as FIXED anchors: never changed, but Gemini flags a confident disagreement ("Gemini thinks this is the …"). Re-run it after moving photos by hand. Matches below 55% go to **Needs a look**. The old per-photo matcher (`/api/match-photo`) is still there behind **One by one**. |
| Camera placement (2nd pass) | `lib/placement.ts`, `app/api/place-photos/route.ts` | Run after the room assignments look right. **One call per room**, with all of its photos (up to 6 per call) and the floor plan with that room outlined in red. Gemini places every camera at once, so the placements agree with each other. It also flags photos that don't belong in the room, with a one-tap move. Keeps room choices and manual flags, and restores camera poses for photos moved by hand. Streams with thought summaries so long calls aren't cut by idle timeouts. Cached per room + photo set. |
| Depth | `lib/depth.worker.ts`, `lib/client/depth.ts`, `lib/depth.ts` | Default is **on-device**: Depth Anything V2 Small via transformers.js (WebGPU, falling back to WASM). It's private and free, with a ~27 MB model download that's cached afterwards. Optional: Replicate (Large). Last resort: a "box room" heuristic. |
| Reconstruction | `lib/geometry.ts`, `lib/layout-fit.ts`, `lib/merge.ts`, `lib/client/room-model.ts` | **Metric depth from the floor:** listing photos are shot level from about 1.5 m, so a floor pixel's true distance follows from its image row. A RANSAC fit of the model's affine inverse depth to that gives metres. Countertops and beds fit the same kind of line; they're rejected because they'd put real pixels below the floor, or make the room bigger than the plan says. When there's too little floor, it falls back to a range from the plan's printed room size. Each photo becomes a depth-displaced mesh, with triangles across depth edges dropped. **For 2+ photos**, each starts at its Gemini plan pose. The farthest point in each image column is taken as wall, and that profile is ICP-fitted to the room's outline (plus the rooms it opens onto) from the plan, trying yaw seeds ±40°. It's accepted only on a strong fit (≥60% of the profile on the outline, ≥80% if depth isn't calibrated). Then a photo-to-photo ICP (±6° / 0.3 m) can nudge it. Photos without a usable pose fall back to one-at-a-time viewing. |
| Stereo view | `components/StereoViewer.tsx` | GPU DIBR: the mesh is rendered from two off-axis eye cameras (`THREE.StereoCamera`), converging on the median scene depth. Cross-eye swaps the eyes, and fusion dots help line up the pair. A dimmed copy of the photo far behind fills disocclusion holes. Also: drag to look around, gyro or mouse parallax, and a dolly forward on exit. |
| Navigation | `components/FloorPlanGraph.tsx`, `app/tour/page.tsx` | Three.js orthographic scene over the floor plan, with room outlines, edges, and tappable nodes. Adjacent-room chips, crossfade transitions, and neighbours pre-built in the background. |
| Caching | `lib/client/idb.ts` | IndexedDB, keyed by image hash (plus graph hash for matches). Reloads and re-runs don't re-spend API calls, and the whole project persists across reloads. |

## Decisions made along the way

- **Depth runs in the browser by default** rather than on Replicate. It needs no key, has no per-photo cost or cold starts, and photos never leave the device for this step. Replicate (Large model) is still one dropdown away when a key is present.
- **Photos are aligned to the plan's walls, not just to each other** (2026-09-24). Two photos of a room overlap only partly, so photo-to-photo ICP had little to grip, and with model depth it drifted up to ~17° from exact poses. Every photo does see the floor and the room's walls, both known from the plan. Measured on the demo house with real on-device depth, starting 25° / 0.7 m off: old pipeline 23–30° off, new 1–3° / ~0.15 m for photos with visible floor. Photos with no usable floor are left at Gemini's pose rather than made worse.
- **Photos are sorted in one call, not one call per photo** (2026-09-24). Per-photo matching can't use the cues a person relies on, like which photos sit next to each other in the listing, or that two photos share a wall colour and a vaulted ceiling. It also re-pays the reasoning cost for every photo. On the demo house the one-call sort placed 9/9 photos correctly for ~$0.13 (per-photo: 9/9 for ~$0.16). The saving grows with photo count, since the one call's thinking doesn't scale per photo. Camera poses were dropped from it, because judged across a whole listing they came back rough; the per-room placement pass does that.
- **No generative gap-filling.** Having an image model invent the unseen parts of a room would make the tour look seamless, but for a buyer it would show walls, windows and fixtures that aren't there. It would also cost per view (and per eye, to stay consistent in stereo). Holes stay visibly dim instead.
- **Merging trusts the floor plan first, ICP second.** On the demo house, unconstrained ICP (with scale) made alignment *worse*: views of a room overlap only partially, so shrinking a cloud raised its "inlier" score. Rigid, bounded ICP that must beat the plan pose fixed it. With exact depth, the poses match ground truth.
- **A synthetic demo house with ground truth** doubles as a test fixture and as a no-key first-run experience.

## Open questions

These are the ones you asked me to raise. Each has my current default in place.

1. **Cache per listing or regenerate?** Currently cached **client-side** in IndexedDB, keyed by image content, so re-running never re-bills for an unchanged photo. There's no server-side cache yet, which means a second device or browser re-runs everything. If that matters, add Vercel Blob or KV keyed by the same hashes.
2. **How many photos are enough?** The room graph comes from the floor plan alone, so photo count doesn't affect it. For 3D, 2–3 photos from different corners of a room give a much fuller merged room than 1. Typical listings (15–25 photos) usually cover the main rooms 1–3×, and bedrooms and baths often once.
3. **Low-confidence matches:** below 55% they're flagged in **Needs a look** but still shown in their best-guess room. Photos Gemini can't place at all are left out of the tour until you pick a room. Exterior shots are grouped separately.
4. **Scraping approach:** a plain server-side fetch plus layered HTML/JSON extraction. It's cheap and works on smaller brokerage sites. Zillow and Redfin usually block it (403 or CAPTCHA), which the UI reports clearly alongside the manual upload. More robust options, each with trade-offs: a headless-browser service (Browserless/ScrapingBee), or a licensed listings API (e.g. via an MLS/IDX feed). The ToS gray area is noted in the UI copy.
