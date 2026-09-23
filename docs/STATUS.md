# Project status & handoff

_Last updated: 2026-09-23. Read this first if you're picking up the project in a new session._

The original brief (goals, pipeline, build order, open questions) is summarized in [README.md](../README.md). This file covers **where things stand**, **what's been verified**, and **what to do next**.

## Where things are

| Build stage (from the brief) | State | Verified how |
|---|---|---|
| 1. Next.js scaffold, intake UI (URL/address + manual upload) | ✅ done | e2e screenshots at phone size |
| 2. Auto-import (scraper + failure/fallback UI) | ✅ built, ❌ **blocked by the big portals** | Redfin: address lookup (`/stingray/…`) and listing pages both return **403** to server requests (the homepage returns 200, so this is bot detection, not the sandbox). Zillow: 403. The failure UI works as designed. See "Scraping options" below |
| 3. Gemini: floor plan → room graph | ✅ built, ⚠️ **never called for real** (no key yet) | normalization unit-tested; UI tested with demo ground truth |
| 4. Gemini: photo → room match | ✅ built, ⚠️ **never called for real** | same as 3 |
| 5. Depth → stereo pair | ✅ done | exact-depth demo engine, plus **real on-device Depth Anything V2** on all 9 demo photos (≈12–17 s/photo on the sandbox's CPU-only WASM; WebGPU phones should be much faster) |
| 6. Multi-photo merge | ✅ done (best effort) | exact depth: ground-truth poses kept exactly. **Real model depth: ICP nudged the (exact) plan poses by up to ~17° / 0.7 m.** It trades rotation for the model's depth-scale errors. The renderer draws the active photo over the others, so the current view stays clean either way |
| 7. Floor-plan node graph UI | ✅ done | e2e: plan tap + chip navigation |
| 8. Gyro parallax | ✅ built, ⚠️ **not tried on a real phone** | desktop mouse-parallax path exercised; iOS permission flow is code-only |
| Access gate (added on request) | ✅ done | curl: locked by default, bogus Gemini key rejected |

## Deployment

- Vercel project **house-viewer** (team `tschomay`), linked to this repo; `main` auto-deploys to production at https://house-viewer-tschomay.vercel.app.
- The first production deploy (commit `b9cd642`) built cleanly and `/api/status` answers **locked**, as intended with no env vars set.
- The user has a setup checklist for keys: https://claude.ai/artifact/N3NShDz3oR7ymn9nxfH4fq
- **Vercel Authentication is on** (team default): the site only opens for people logged into the `tschomay` Vercel team. Turning it off for sharing is the user's call (Project → Settings → Deployment Protection). The app's own access gate still protects the API keys either way.

## Scraping options (portals block server fetches)

Ranked by effort:
1. **Manual upload** (works today): save the listing's photos and floor plan on the phone and add them on the Listing page.
2. **"Send to House Viewer" bookmarklet or share flow** (recommended next build): runs in the user's own browser on the listing page, where they're a normal visitor. It collects the photo URLs from the page and opens House Viewer with them. The server then fetches only the images, whose CDN hosts (`ssl.cdn-redfin.com`, `photos.zillowstatic.com`) usually aren't bot-protected; still to be verified. Bookmarklets are awkward on iOS Safari, so a "copy page source → paste" fallback may be needed.
3. **Scraping API with residential proxies** (ScrapingBee, ZenRows, Apify's Zillow/Redfin actors): drop-in replacement for the server fetch in `lib/importer.ts`. Paid per request, and the ToS gray area gets darker.

## Blocked on / waiting for

1. **API keys**
   - For the deployed app: set in **Vercel → house-viewer project → Settings → Environment Variables**: `ACCESS_PASSWORD`, `GEMINI_API_KEY`, optionally `REPLICATE_API_TOKEN`.
   - For an agent testing in a Claude Code cloud session: set the same names as **environment variables in the cloud environment's settings**. The app reads `process.env` directly, so `npm run dev` picks them up.
2. **Network (cloud sandbox only):** hosts needed: `www.redfin.com`, `www.zillow.com`, `www.homes.com`, `api.replicate.com`, **`replicate.delivery`** (Replicate serves output files from here), `huggingface.co`, `us.aws.cdn.hf.co`, and `house-viewer-tschomay.vercel.app` (to smoke-test the deployment; `mcp__Vercel__web_fetch_vercel_url` also works). As of the last session, `api.replicate.com` and `us.aws.cdn.hf.co` were reachable, but `www.redfin.com`, `www.zillow.com` and `www.homes.com` were still refused by the sandbox proxy. Check with `curl -sS -o /dev/null -w "%{http_code}" https://www.redfin.com/`. `000` plus a CONNECT 403 means the sandbox is blocking it; a real HTTP status means the site answered.

## Next steps (in order)

1. **First real Gemini run.** Once `GEMINI_API_KEY` is available, run the demo house through "Read floor plan with Gemini" and "Match with Gemini", then compare against the demo's ground truth (room ids and adjacency; heading within ±45°; position within ~1 m). Tune the prompts in `lib/gemini.ts` from what you see. Also confirm the model id `gemini-3.1-pro-preview` is right (`GEMINI_MODEL` overrides it). It couldn't be checked from the sandbox.
2. **Sample listing: 36316 S Park Dr, Avon, OH 44011** (the user's choice; listed on [Homes.com](https://www.homes.com/property/36316-s-park-dr-avon-oh/7jg6pmref07qn/), Zillow and Redfin). Try auto-import. If the portals block the server fetch (likely), note the exact failure and fall back to manual upload of that listing's photos and floor plan. Then run the full pipeline on real photos. This is the first real-world test of matching, merge and stereo comfort.
3. **Tune the merge on real photos.** Known issue from the demo: with model depth, ICP drifts from correct plan poses. Try, in order: (a) fit a per-photo depth scale/shift so the floor plane sits at camera height −1.5 m and walls match the plan's room box, *before* ICP; (b) tighten ICP bounds (currently ±20°/0.8 m) or require a larger overlap gain than +0.05; (c) compare against Gemini-estimated poses rather than exact ones, since ICP may still help there. Real photos have lens distortion, unknown FOV (assumed 75° horizontal) and non-metric depth. Look at `inlierRatio` in the `[room-model]` console.debug lines. If rooms look misaligned, try the per-room depth scale from printed dimensions first, before loosening the ICP bounds in `lib/merge.ts`.
4. **Replicate path.** With `REPLICATE_API_TOKEN` set, check that `/api/depth` works end to end (the model version is pinned in `lib/depth.ts`; its input/output schema was verified from the model page).
5. **Real-phone pass.** Cross-eye comfort (Depth slider default of 1.0 may be too strong), iOS motion permission, landscape layout, WebGPU vs WASM depth speed.
6. **Open questions** from the brief are answered with defaults in the README. Revisit server-side caching (Vercel Blob/KV) if multi-device use matters.

## How to test

```bash
npm install            # .npmrc skips onnxruntime-node's native download (not needed)
npm test && npm run typecheck && npm run lint
npm run build && npx next start -p 3100 &
DEPTH_ENGINE=truth   node scripts/e2e-demo.mjs http://localhost:3100 shots   # geometry check, instant
DEPTH_ENGINE=browser node scripts/e2e-demo.mjs http://localhost:3100 shots   # real depth model
VERBOSE=1 ...          # prints browser console, including [room-model] pose/inlier lines
```

The demo-house ground truth (camera positions, headings, room boxes) is in `lib/client/demo.ts` (`ROOMS`, `SHOTS`).

## Gotchas learned the hard way

- **Killing the dev server:** `pkill -f "next start"` also matches the shell that runs it and kills your own command (exit 144). Use `kill $(pgrep -f "[n]ext-server")` in a separate command.
- **Headless Chromium in the sandbox** needs `--ignore-certificate-errors` to fetch through the agent proxy. The e2e script already passes it.
- **`LayoutProps`** (Next 16 typegen) doesn't exist before the first build, so `app/layout.tsx` types `children` by hand.
- **Next 16 lint** (`react-hooks/refs`, `set-state-in-effect`) rejects writing refs during render and calling setState synchronously in effects. Follow the existing patterns in `StereoViewer.tsx` and `tour/page.tsx`.
- **onnxruntime-web** WASM files are copied into `public/ort/` by `scripts/copy-ort.mjs` before dev/build (gitignored). The depth worker loads them from there, not from a CDN. **Copy every variant**: ORT picks `asyncify`/`jsep`/`jspi`/plain at runtime, and a missing one made model loading hang forever with no error (fixed; `lib/client/depth.ts` also has a 60 s stall watchdog now).
- **Monocular depth is relative.** Everything metric comes from assumptions (`DEFAULT_INTRINSICS` in `lib/geometry.ts`) plus the plan's printed room sizes.
