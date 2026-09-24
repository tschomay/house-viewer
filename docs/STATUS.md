# Project status & handoff

_Last updated: 2026-09-24 (3D fly-through added). Read this first if you're picking up the project in a new session._

The original brief (goals, pipeline, build order, open questions) is summarized in [README.md](../README.md). This file covers **where things stand**, **what's been verified**, and **what to do next**.

## Where things are

| Build stage (from the brief) | State | Verified how |
|---|---|---|
| 1. Next.js scaffold, intake UI (URL/address + manual upload) | ✅ done | e2e screenshots at phone size |
| 2. Auto-import (scraper + failure/fallback UI) | ✅ built, ❌ **server fetch blocked by the big portals**; ✅ **bookmarklet import added** | Redfin listing pages now return **HTTP 202 with an AWS WAF JavaScript challenge** (`challenge.js` from `*.token.awswaf.com`), not the listing. The address lookup returns 403. Zillow and Homes.com return 403. Even headless Chromium can't pass from the sandbox, because the sandbox blocks the WAF token host. The bookmarklet flow was tested end to end on a stand-in listing page with Hugging Face-hosted images, but **not yet on real Redfin**. See "Scraping options" |
| 3. Gemini: floor plan → room graph | ✅ **verified with the real API** (2026-09-24) | demo house: all 6 rooms and exactly the 6 true connections; printed sizes read to within 0.01 m. ~9 s, ≈$0.016 |
| 4. Gemini: photo → room match | ✅ **verified with the real API** | demo house: **9/9 photos in the right room**, all headings within 45° (6 exact), positions mostly within ~0.7 m (kitchen corner shot ~1.8 m off, dining ~1.2 m). ~36 s for 9 photos (3 in parallel), ≈$0.16 |
| 5. Depth → stereo pair | ✅ done | exact-depth demo engine, plus **real on-device Depth Anything V2** on all 9 demo photos (≈12–17 s/photo on the sandbox's CPU-only WASM; WebGPU phones should be much faster) |
| 4a. Gemini: one-call sort (all photos, compared with each other) | ✅ **verified with the real API** (2026-09-24) | demo house, all matches wiped: **9/9 in the right room**, 90% each, useful appearance notes ("beige walls, wood floor, flat ceiling, TV"). One call, 72 s, **≈$0.13** on Pro. **On Flash (now the default): 9/9, 12 s, ≈$0.01.** Per-photo matching was ≈$0.16 for these 9 and grew linearly; it's retired. Not yet tested on a listing with look-alike rooms (two similar bedrooms), which is where comparing photos should matter most |
| 4b. Gemini: camera placement pass (one call per room) | ✅ **verified with the real API** (2026-09-24) | demo house, camera poses wiped first (as after manual room picks): **9/9 placed**, 6 headings exact, the others 10°, 15° and 25° off, positions 0.12–0.48 m. 6 calls, ~60 s (2 in parallel), **≈$0.10–0.12 for the house**. The 3-photo living-room call thinks for ~38 s: the sandbox proxy cut it at 30 s until the call was switched to streaming with thought summaries |
| 6. Multi-photo merge | ✅ **reworked 2026-09-24** | Depth is calibrated to metres from the floor, and each photo is snapped to the plan's room outline before the photo-to-photo ICP (`lib/layout-fit.ts`). Real on-device depth, Gemini guesses perturbed by 25° / 0.7 m: **old pipeline 23–30° off, new 1–3° / ~0.15 m** for photos with visible floor. The full real-API run (placement pass + model depth) merged all 3 living-room photos at 0.5–4° / 0.1–0.5 m. Photos with little floor (kitchen island, bed filling the frame) stay at Gemini's pose. Previously ICP alone drifted up to ~17° from exact poses |
| 7. Floor-plan node graph UI | ✅ done | e2e: plan tap + chip navigation |
| 8. Gyro parallax | ✅ built, ⚠️ **not tried on a real phone** | desktop mouse-parallax path exercised; iOS permission flow is code-only |
| Access gate (added on request) | ✅ done | curl: locked by default, bogus Gemini key rejected |
| Manual camera editor | ✅ done (2026-09-24) | **Set camera** on a photo card: tap the plan + aim slider. Checked in the browser (pose saved with `manualPose`). The placement pass keeps hand-set cameras and gives them to Gemini as fixed references |
| Seam feathering | ✅ done (2026-09-24) | side edges of the current photo fade into neighbours as you turn; off at rest. Checked with screenshots |
| 3D fly-through (optional, `/flythrough`) | ✅ **built 2026-09-24, checked on the demo and the real Avon house** | See "3D fly-through" below. Headless screenshots along the whole route, mono and cross-eye, with and without AI walls and depth meshes; no page errors. Not yet tried on a real phone or a VR headset |
| Gemini cost tracker | ✅ done | each Gemini button shows its last run's estimated cost and tokens, plus this device's running total (localStorage, with reset). Cached re-runs show as free. Rates in `lib/cost.ts` were checked against ai.google.dev pricing on 2026-09-24 |

## First real-house run (user, 2026-09-24): issues found and fixed

- **Map dots all piled on the plan's bottom edge.** Gemini's room *bounding boxes* were right, but its separate centre points were not. A re-run on a crop of the same plan gave one centre at y = 2.21; in the user's saved project, apparently every centre was past the edge, and those get clamped to 1. Fix: a centre outside its own box is replaced by the box centre (`repairCentroids` in `lib/room-graph.ts`). New graphs are fixed at normalization. Saved graphs are fixed only when drawn, so their cache keys (and the paid Gemini results behind them) stay valid.
- **Placement for a 6-photo master suite timed out** (Vercel logs: "Task timed out after 120 seconds", twice, since the client retries once). `/api/place-photos` now allows 300 s, and big rooms are split into calls of ≤4 photos. The error now says "timed out", and that tapping **Re-place cameras** retries only the failed rooms (finished rooms come from cache).
- **Export / Import project** (Listing page): the whole project as one JSON file, depth maps excluded. Used to hand the real house to a debugging session, since projects live only in the phone's IndexedDB.

## Tour controls (user request, 2026-09-24)

- **Width slider** (side-by-side layouts): squeezes the stereo pair towards the middle of the screen. A landscape phone is wider than the viewer's eyes are apart, which made the pair hard to fuse. Saved per device, as are Depth and layout (`lib/client/prefs.ts`).
- **Tap for directions**: a tap (not a drag) on the 3D view shows arrow buttons to each connected room, placed by where the room lies relative to the way the current photo faces (↑ ahead, ↙ behind-left…), plus Depth/Width sliders. Tap an arrow to walk there. Auto-hides after 8 s. Checked in a landscape phone-sized browser: arrows point correctly from the demo living room, the Width slider works, and the Kitchen arrow navigates.

## Real-house test data and findings (2026-09-24)

**Fixtures:** the user's real house (36316 S Park Dr, Avon OH) is in the **private** repo `tschomay/house-viewer-fixtures`: a project export (40 photos, 20-room two-storey plan, sort + placements) and its on-device depth maps. Never copy them into this public repo. Attach it in a session with `add_repo`, then run:
`ACCESS_PASSWORD=... node scripts/e2e-real-tour.mjs <outDir> ../house-viewer-fixtures/projects/avon-36316-s-park-dr.json ../house-viewer-fixtures/depth/avon-36316-s-park-dr.browser.json`
It imports, adds depth in ~3 s, tours the multi-photo rooms, and saves screenshots plus `[room-model]` lines.

**What the first real run showed:**
- Every multi-photo room merges (Family 5, Kitchen 5, Living 4, Library/Foyer/MBath 3, Dining 2), but only because Gemini's placements anchor them. **The plan-outline fit was rejected for every photo.** Calibrated photos put walls 5–8 m away in rooms 3–5 m across. Causes:
  - the 75° lens assumption, where real-estate photos are ~90–100° across (going wider helps but doesn't fix it);
  - open-plan views (kitchen / nook / family) that break "farthest point per column = wall";
  - Depth Anything on real photos not being the clean affine inverse depth the floor fit assumes.

  The acceptance thresholds did their job: no photo was moved to a wrong pose.
- **Looking around a merged room smears badly on real photos:** neighbouring photos' depth meshes, seen from a few metres off their own viewpoint with imperfect poses, stretch into streaks. At rest each photo looks fine.
- Proposal, not built yet (waiting on the user): in merged rooms, turning past the current photo's edge **steps to the neighbouring photo** that faces that way, instead of rendering smeared neighbours. Each photo is then only ever seen from its own viewpoint, and poses only need to be right to within ~30° (which Gemini's placements are).

## More tour/map controls (user requests, 2026-09-24)

- **Navigation arrows in 3D**: the tap-to-show directions are now Street View-style chevrons drawn on the floor in the scene, with a floating room label, so they appear in depth in the stereo pair. Tapping one in either eye's image walks there: raycast per eye viewport; three.js's StereoCamera doesn't update `projectionMatrixInverse`, so it's refreshed before each raycast. Rooms beside or behind you are pinned to the lower edge of the view, still pointing their true way. Checked in a landscape viewport: tapping the Kitchen arrow navigates. HTML buttons remain only for rooms with no photos.
- **Width is remembered separately for portrait and landscape** (`usePairWidth`; landscape starts at 0.7).
- **Zoomable floor plan maps** (Analyze page and Set camera): pinch or wheel to zoom, drag to pan when zoomed, +/−/⤢ buttons. The page itself doesn't zoom. Dots and arrows keep their on-screen size, and overlapping room labels are hidden until you zoom in. Set camera opens zoomed onto the photo's room, and a tap places the camera where you tapped. Checked on the user's real house export.

## 3D fly-through (user request, 2026-09-24)

An optional add-on: the whole house as a 3D model, with a guided flight through it. Open **3D** in the top bar (also linked from Analyze and Tour). Needs the room map and placed cameras; depth and AI walls are extras.

- **Model** (`lib/house-model.ts`): storeys found by clustering plan boxes, stacked and aligned by their stairs. Rooms become boxes from the plan, with doorways cut between connected rooms and a front door on the entry. On Avon: 2 floors, 20 rooms, the stairs detected inside the foyer, and the front door on the foyer's street side, all correct.
- **Painting**: each room's placed photos are projected back from their cameras. Near a viewpoint, the photo's depth mesh (if depth was run) fades in for real parallax. Unseen walls show AI wall art, or colours sampled from the photos without it.
- **Route**: aerial approach → front door → every room, pausing ~2.5 s at each photo's viewpoint facing its way → upstairs → rise out to an overview. Avon: 17 rooms, **4:21 at 1×**. Controls: play/pause (or tap the view), speed 0.25–3×, scrubber with a mark per room, room chips to jump. Drag, **Tilt** (device orientation) or a WebXR headset (**VR** button, shown only when supported) to look around while it plays. **⟲ Ahead** re-centres. Stereo layouts are shared with the tour.
- **AI wall fill**: one Gemini 3.1 Flash Image call per room (4 wall elevations in one image). **Avon: 14 rooms for $0.975** (two runs, $0.975 and $0.974; the estimate said $0.98). ~7–13 s a call, 3 in parallel. Optional "imagine rooms with no photos" (labelled in the viewer) and "careful (Pro)" (~2×). So a full Avon run is ≈ $2 (existing pipeline) + ≈ $1 (walls).
- **Verified**: `npm test` (14 new tests: storeys, stairs, doorways, front door, texture orientation, tour order, stops facing each photo's way, the route never leaves the rooms, prompt/validation); `scripts/e2e-flythrough.mjs` on the demo and on the Avon fixture (with `DEPTH=` the fixture's depth maps and `WALLS=1`), screenshots checked by eye.
- **Known gaps**: (1) photos without a camera position aren't used (Avon's master suite: run **Place cameras**). (2) Away from viewpoints, furniture is flattened onto walls and floor, and where two photos overlap there's some ghosting. (3) Stairs have no geometry: the flight climbs them, and the photos show the real ones. (4) A gap between two plan boxes (a hallway Gemini didn't list) is walked through in the open. (5) WebXR and Tilt are code-only: not tried on a headset or phone. (6) The VR rig turns with the path, which can be uncomfortable; a "no auto-turn" comfort option would be easy.
- **Other tools worth trying** (user asked): **World Labs Marble API** (photos → explorable Gaussian-splat world): the most likely route to truly photoreal rooms, with its own account and key at roughly tens of cents per room. **Replicate** (already half-wired for depth) hosts image-to-3D and panorama models. **Veo 3.1** (on the same Gemini key; Fast ≈ $0.10/s at 720p) could render a cinematic clip per room from its best photo: ~$0.80 for 8 s, so as a per-room opt-in, not for the whole house.
- **Test command**: `ACCESS_PASSWORD=... PROJECT=../house-viewer-fixtures/projects/avon-36316-s-park-dr.json DEPTH=../house-viewer-fixtures/depth/avon-36316-s-park-dr.browser.json [WALLS=1 | WALLART=<out>/wallart.json] [LAYOUT=cross] node scripts/e2e-flythrough.mjs http://localhost:3100 <out>`. `WALLS=1` spends ≈$1 and saves the art to `<out>/wallart.json`; `WALLART=` reuses it for free.

## Deployment

- Vercel project **house-viewer** (team `tschomay`), linked to this repo; `main` auto-deploys to production at https://house-viewer-tschomay.vercel.app.
- The first production deploy (commit `b9cd642`) built cleanly and `/api/status` answers **locked**, as intended with no env vars set.
- The user has a setup checklist for keys: https://claude.ai/artifact/N3NShDz3oR7ymn9nxfH4fq
- **Vercel Authentication is on** (team default): the site only opens for people logged into the `tschomay` Vercel team. Turning it off for sharing is the user's call (Project → Settings → Deployment Protection). The app's own access gate still protects the API keys either way.

## Scraping options (portals block server fetches)

1. **Manual upload** (always works): save the listing's photos and floor plan on the phone and add them on the Listing page.
2. **"Send to House Viewer" bookmarklet** (built, `lib/bookmarklet.ts` + `components/BookmarkletCard.tsx`). It runs on the listing page in the user's own browser, which has already passed the WAF challenge, and collects image URLs from the rendered DOM and its inline JSON. It then navigates to `/#import=<json>`; the hash never reaches a server, and Vercel's login cookie still applies to a top-level GET. The Listing page filters the URLs with the server parser's rules (`normalizeFoundImages`), waits for unlock if needed (the hash survives a reload), resets the project and downloads the images through `/api/proxy-image`. Setup instructions for Android Chrome are on the card: run it by typing its name in the address bar, not from the Bookmarks screen. **Still unverified:** (a) whether Redfin's rendered page includes every gallery photo URL or only the visible ones (the card says to open the gallery first); (b) whether `ssl.cdn-redfin.com` serves images to Vercel's server. The sandbox blocks that host, so it couldn't be checked here. If (b) fails, have the bookmarklet fetch the images in-page and hand over blobs via `postMessage` to a `window.open`ed House Viewer tab.
3. **Scraping API with residential proxies** (ScrapingBee, ZenRows, Apify's Zillow/Redfin actors): drop-in replacement for the server fetch in `lib/importer.ts`. Paid per request, and the ToS gray area gets darker.

## Blocked on / waiting for

1. **API keys**
   - **Cloud-session setup (resolved 2026-09-24):** the Gemini credential is injected by the agent proxy and **overrides** any `x-goog-api-key` the client sends. Run the app with `GEMINI_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1`. **`NODE_USE_ENV_PROXY=1` is required:** without it, Node's `fetch` bypasses the agent proxy, the key isn't injected, and Google answers `API_KEY_INVALID`. The historical notes below are kept for reference.
   - For the deployed app: set in **Vercel → house-viewer project → Settings → Environment Variables**: `ACCESS_PASSWORD`, `GEMINI_API_KEY`, optionally `REPLICATE_API_TOKEN`.
   - For an agent testing in a Claude Code cloud session: the user is adding the keys as **cloud-environment API credentials**, not environment variables. The agent proxy injects the header on outbound requests, so the key never appears in the VM, env vars or transcript. Planned setup:
     - Gemini: host `generativelanguage.googleapis.com`, header `x-goog-api-key`, no prefix.
     - Replicate (optional): host `api.replicate.com`, header `Authorization`, prefix `Bearer`.
     **Consequence for the code:** `process.env.GEMINI_API_KEY` is empty in the session, so the app reports "no key" and disables the Gemini buttons. First task in the next session:
     1. Verify injection: `curl -s "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"` with no key should return JSON models, not a 403.
     2. Check whether the proxy **overrides** an existing header: repeat with `-H "x-goog-api-key: proxy-injected"`.
     3. If it overrides, set plain env vars `GEMINI_API_KEY=proxy-injected` / `REPLICATE_API_TOKEN=proxy-injected` for `npm run dev` (not secrets; put them in `.env.local` or the command line). If it doesn't, add a small escape hatch in `lib/gemini.ts` / `lib/depth.ts` that omits the auth header when the value is `proxy-injected`.
     Vercel still needs the real keys as normal env vars; the proxy only exists in Claude cloud sessions.
2. **Network (cloud sandbox only):** hosts needed: `www.redfin.com`, `www.zillow.com`, `www.homes.com`, `api.replicate.com`, **`replicate.delivery`** (Replicate serves output files from here), `huggingface.co`, `us.aws.cdn.hf.co`, and `house-viewer-tschomay.vercel.app` (to smoke-test the deployment; `mcp__Vercel__web_fetch_vercel_url` also works). As of the last session, `api.replicate.com` and `us.aws.cdn.hf.co` were reachable, but `www.redfin.com`, `www.zillow.com` and `www.homes.com` were still refused by the sandbox proxy. Check with `curl -sS -o /dev/null -w "%{http_code}" https://www.redfin.com/`. `000` plus a CONNECT 403 means the sandbox is blocking it; a real HTTP status means the site answered.

## Next steps (in order)

1. ~~First real Gemini run~~ done 2026-09-24 (see table). The model id `gemini-3.1-pro-preview` is listed by the API. Prompts need no tuning for the demo house; revisit on real photos.
2. **Sample listing: 36316 S Park Dr, Avon, OH 44011**: https://www.redfin.com/OH/Avon/36316-S-Park-Dr-44011/home/77239821. **User report (2026-09-24): importing this listing from Redfin worked from the deployed app** (the WAF challenge that blocks the sandbox apparently doesn't block Vercel), and "as a first pass everything works". The bookmarklet was never needed, so it's still untested on real Redfin. The full pipeline on this house cost **about $2 in Gemini**, mostly the per-photo match calls (Pro model thinking tokens). Keep cost in mind before adding more per-photo or generative calls.
3. **Check the reworked merge on real photos** (done on the demo: floor calibration + plan-outline fit, see table). Workflow on a real listing: **Sort with Gemini** → fix rooms by hand → **Re-check** (optional; uses your picks as anchors) → **Place cameras** → check the orange arrows on the map → depth → tour. The `[room-model]` console.debug lines now show `calib` (fitted far distance, or `false`) and `outline` (share of wall profile on the plan outline, or `null` if not snapped). Knobs, if real rooms misbehave: camera height `CAMERA_HEIGHT_M` (1.5 m; real photographers range ~1.2–1.6), the fit acceptance thresholds (0.6 / 0.8) and yaw search (±40°) in `fitToRoomBox`, and the furniture checks in `calibrateFromFloor`. Real photos also add lens distortion and an unknown FOV (assumed 75° horizontal), neither of which the demo exercises. Known weak spots: a photo that sees only one wall can slide along it (the tie-break prefers Gemini's position), and a square room is ambiguous under a 90° turn if Gemini's heading is off by more than ~45°.
4. **Ideas not built yet**, roughly by value per cost: (a) ~~manual camera nudge~~ done: **Set camera** on each photo card (tap plan + aim slider), checked in the browser; hand-set cameras are fixed anchors for the placement pass; (b) ~~corner bearings~~ tried and dropped: accurate corners, but most photos show only one, no pose gain, 2.7× placement cost (see README decisions); (c) ~~seam feathering~~ done: side edges fade as you turn, off at rest (checked with screenshots at rest and turned); (d) ~~cheaper matching~~ done: the one-call sort, on Flash by default (~$0.01 for the demo), with a **Careful (Pro)** button. Placement stays on Pro: **Flash was tried for placement and is worse** (demo: bedroom 90° off / 2.5 m, one kitchen photo 45° off / 2 m, against all within 25° on Pro) and only ~35% cheaper ($0.075 vs ~$0.11).
5. **Replicate path: possible future improvement, not set up.** The user hasn't created a Replicate account, and on-device depth (Depth Anything V2 Small) is the default and works. Replicate would add the Large model on the server for sharper depth on slow phones, at a per-photo cost. To try it: set `REPLICATE_API_TOKEN` (Vercel env var, or a cloud-session API credential for `api.replicate.com` with header `Authorization`, prefix `Bearer`), then check `/api/depth` end to end. The model version is pinned in `lib/depth.ts`. If adopted, extend the cost tracker to Replicate's per-second billing.
6. **Real-phone pass.** Cross-eye comfort (Depth slider default of 1.0 may be too strong), iOS motion permission, landscape layout, WebGPU vs WASM depth speed.
7. **3D fly-through next steps**: try it on a phone and a headset; place the Avon master suite cameras; use the outline-fitted poses from `buildRoomModel` (they're better than Gemini's raw ones) for the projectors; a comfort mode for VR; optionally World Labs or Veo for a more photoreal look (see "3D fly-through").
8. **Open questions** from the brief are answered with defaults in the README. Revisit server-side caching (Vercel Blob/KV) if multi-device use matters.

## How to test

```bash
npm install            # .npmrc skips onnxruntime-node's native download (not needed)
npm test && npm run typecheck && npm run lint
npm run build && GEMINI_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1 npx next start -p 3100 &   # cloud session: real Gemini via the proxy
DEPTH_ENGINE=truth   node scripts/e2e-demo.mjs http://localhost:3100 shots   # geometry check, instant
DEPTH_ENGINE=browser node scripts/e2e-demo.mjs http://localhost:3100 shots   # real depth model
ACCESS_PASSWORD=... MODE=perturb DEPTH_ENGINE=browser node scripts/e2e-placement.mjs http://localhost:3100  # merge vs ground truth, poses perturbed 25°/0.7 m, free
ACCESS_PASSWORD=... MODE=gemini  DEPTH_ENGINE=browser node scripts/e2e-placement.mjs http://localhost:3100  # real placement pass, ≈$0.12
ACCESS_PASSWORD=... MODE=sort node scripts/e2e-placement.mjs http://localhost:3100  # real one-call sort, scored per room, ≈$0.13
VERBOSE=1 ...          # prints browser console, including [room-model] pose/inlier lines
```

The demo-house ground truth (camera positions, headings, room boxes) is in `lib/client/demo.ts` (`ROOMS`, `SHOTS`).

## Gotchas learned the hard way

- **Killing the dev server:** `pkill -f "next start"` also matches the shell that runs it and kills your own command (exit 144). Use `kill $(pgrep -f "[n]ext-server")` in a separate command.
- **Headless Chromium in the sandbox** needs `--ignore-certificate-errors` to fetch through the agent proxy. The e2e script already passes it.
- **`LayoutProps`** (Next 16 typegen) doesn't exist before the first build, so `app/layout.tsx` types `children` by hand.
- **Next 16 lint** (`react-hooks/refs`, `set-state-in-effect`) rejects writing refs during render and calling setState synchronously in effects. Follow the existing patterns in `StereoViewer.tsx` and `tour/page.tsx`.
- **onnxruntime-web** WASM files are copied into `public/ort/` by `scripts/copy-ort.mjs` before dev/build (gitignored). The depth worker loads them from there, not from a CDN. **Copy every variant**: ORT picks `asyncify`/`jsep`/`jspi`/plain at runtime, and a missing one made model loading hang forever with no error (fixed; `lib/client/depth.ts` also has a 60 s stall watchdog now).
- **Playwright:** don't `npm i playwright` (a newer version wants its own browser download). If you do, launch with `executablePath: "/opt/pw-browsers/chromium"`.
- **The sandbox's agent proxy cuts Gemini requests at ~30 s** if no bytes flow ("upstream request failed", 502). Vercel allows these routes 120 s. Long multi-image calls stream with `thinkingConfig.includeThoughts` so something arrives every couple of seconds (`placePhotos` in `lib/gemini.ts`).
- **Gemini cost** is estimated from `usageMetadata` (thinking tokens bill as output). Thinking tokens dominate every call's cost; that's why the one-call sort (one reasoning pass for all photos) and Flash make such a difference.
- **Monocular depth is relative.** Everything metric comes from assumptions (`DEFAULT_INTRINSICS` in `lib/geometry.ts`) plus the plan's printed room sizes.
