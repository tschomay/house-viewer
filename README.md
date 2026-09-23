# House Viewer

A phone-first web app that turns a real-estate listing's photos and floor plan into a room-by-room **stereoscopic tour**. Hold the phone close and cross your eyes; no headset needed.

```
Listing (URL / address / manual upload)
   │
   ├─ floor plan ──▶ Gemini ──▶ room graph (rooms, adjacency, centroids, bounds, sizes)
   │                                 │
   ├─ each photo ──▶ Gemini ─────────┴─▶ room match + camera heading/position on the plan
   │
   ├─ each photo ──▶ Depth Anything V2 ──▶ relative depth map
   │                (on-device, or Replicate)
   │
   └─ per room: depth → 3D mesh; 2+ photos → placed by plan pose, refined by bounded ICP
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

Every server route that costs money or fetches arbitrary URLs (`/api/room-graph`, `/api/match-photo`, `/api/depth`, `/api/import`, `/api/proxy-image`) needs one of:

1. **The access password** (`x-access-password` header, entered on the Listing page). This unlocks the server's keys.
2. **The visitor's own Gemini key** (`x-gemini-key`). The server checks it with Google once (then caches the result for 30 minutes) and uses it for that visitor only. A Replicate token can come with it.

With neither, those routes return 401. In `next dev` with no `ACCESS_PASSWORD` set, the gate is open for convenience. Credentials live only in the visitor's `localStorage`. The demo house and on-device depth never touch the gated routes.

## How it works

| Stage | Where | Notes |
|---|---|---|
| Auto-import | `lib/importer.ts`, `lib/listing-parse.ts` | Fetches the page server-side and pulls images from JSON-LD, `og:image`, `<img>` and inline JSON blobs. Keeps the largest size of each photo and flags floor plans by caption or URL. An address goes through Redfin's autocomplete. Blocks and CAPTCHAs return a readable reason, and the UI falls through to manual upload. SSRF-guarded (`lib/safe-fetch.ts`). |
| Room graph | `lib/gemini.ts`, `lib/room-graph.ts` | Structured JSON output with a schema. Normalization dedupes ids, clamps coordinates, drops unknown neighbours, and makes adjacency symmetric. The raw output is logged and shown on the Analyze page. |
| Photo matching | same | One request per photo (fits Vercel's 4.5 MB body limit). Returns a room, confidence, camera heading and position on the plan, and its reasoning. Matches below 55% go to a **Needs a look** tray. You can reassign any photo by hand, and manual picks survive re-runs. |
| Depth | `lib/depth.worker.ts`, `lib/client/depth.ts`, `lib/depth.ts` | Default is **on-device**: Depth Anything V2 Small via transformers.js (WebGPU, falling back to WASM). It's private and free, with a ~27 MB model download that's cached afterwards. Optional: Replicate (Large). Last resort: a "box room" heuristic. |
| Reconstruction | `lib/geometry.ts`, `lib/merge.ts`, `lib/client/room-model.ts` | Relative inverse depth is mapped to metres, with `far` taken from the plan's printed room size. Each photo becomes a depth-displaced mesh, with triangles across depth edges dropped. For 2+ photos, each is placed at its Gemini plan pose (plan units → metres via room bounds and printed dimensions). A **rigid ICP bounded to ±20° / 0.8 m** can nudge it, and only when overlap clearly improves. Photos without a usable pose fall back to one-at-a-time viewing. |
| Stereo view | `components/StereoViewer.tsx` | GPU DIBR: the mesh is rendered from two off-axis eye cameras (`THREE.StereoCamera`), converging on the median scene depth. Cross-eye swaps the eyes, and fusion dots help line up the pair. A dimmed copy of the photo far behind fills disocclusion holes. Also: drag to look around, gyro or mouse parallax, and a dolly forward on exit. |
| Navigation | `components/FloorPlanGraph.tsx`, `app/tour/page.tsx` | Three.js orthographic scene over the floor plan, with room outlines, edges, and tappable nodes. Adjacent-room chips, crossfade transitions, and neighbours pre-built in the background. |
| Caching | `lib/client/idb.ts` | IndexedDB, keyed by image hash (plus graph hash for matches). Reloads and re-runs don't re-spend API calls, and the whole project persists across reloads. |

## Decisions made along the way

- **Depth runs in the browser by default** rather than on Replicate. It needs no key, has no per-photo cost or cold starts, and photos never leave the device for this step. Replicate (Large model) is still one dropdown away when a key is present.
- **Merging trusts the floor plan first, ICP second.** On the demo house, unconstrained ICP (with scale) made alignment *worse*: views of a room overlap only partially, so shrinking a cloud raised its "inlier" score. Rigid, bounded ICP that must beat the plan pose fixed it. With exact depth, the poses match ground truth.
- **A synthetic demo house with ground truth** doubles as a test fixture and as a no-key first-run experience.

## Open questions

These are the ones you asked me to raise. Each has my current default in place.

1. **Cache per listing or regenerate?** Currently cached **client-side** in IndexedDB, keyed by image content, so re-running never re-bills for an unchanged photo. There's no server-side cache yet, which means a second device or browser re-runs everything. If that matters, add Vercel Blob or KV keyed by the same hashes.
2. **How many photos are enough?** The room graph comes from the floor plan alone, so photo count doesn't affect it. For 3D, 2–3 photos from different corners of a room give a much fuller merged room than 1. Typical listings (15–25 photos) usually cover the main rooms 1–3×, and bedrooms and baths often once.
3. **Low-confidence matches:** below 55% they're flagged in **Needs a look** but still shown in their best-guess room. Photos Gemini can't place at all are left out of the tour until you pick a room. Exterior shots are grouped separately.
4. **Scraping approach:** a plain server-side fetch plus layered HTML/JSON extraction. It's cheap and works on smaller brokerage sites. Zillow and Redfin usually block it (403 or CAPTCHA), which the UI reports clearly alongside the manual upload. More robust options, each with trade-offs: a headless-browser service (Browserless/ScrapingBee), or a licensed listings API (e.g. via an MLS/IDX feed). The ToS gray area is noted in the UI copy.
