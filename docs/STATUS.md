# Project status & handoff

_Last updated: 2026-09-24. Read this first if you're picking up the project in a new session._

The original brief (goals, pipeline, build order, open questions) is summarized in [README.md](../README.md). This file covers **where things stand**, **what's been verified**, and **what to do next**.

## Where things are

| Build stage (from the brief) | State | Verified how |
|---|---|---|
| 1. Next.js scaffold, intake UI (URL/address + manual upload) | ✅ done | e2e screenshots at phone size |
| 2. Auto-import (scraper + failure/fallback UI) | ✅ built, ❌ **server fetch blocked by the big portals**; ✅ **bookmarklet import added** | Redfin listing pages now return **HTTP 202 with an AWS WAF JavaScript challenge** (`challenge.js` from `*.token.awswaf.com`), not the listing. The address lookup returns 403. Zillow and Homes.com return 403. Even headless Chromium can't pass from the sandbox, because the sandbox blocks the WAF token host. The bookmarklet flow was tested end to end on a stand-in listing page with Hugging Face-hosted images, but **not yet on real Redfin**. See "Scraping options" |
| 3. Gemini: floor plan → room graph | ✅ **verified with the real API** (2026-09-24) | demo house: all 6 rooms and exactly the 6 true connections; printed sizes read to within 0.01 m. ~9 s, ≈$0.016 |
| 4. Gemini: photo → room match | ✅ **verified with the real API** | demo house: **9/9 photos in the right room**, all headings within 45° (6 exact), positions mostly within ~0.7 m (kitchen corner shot ~1.8 m off, dining ~1.2 m). ~36 s for 9 photos (3 in parallel), ≈$0.16 |
| 5. Depth → stereo pair | ✅ done | exact-depth demo engine, plus **real on-device Depth Anything V2** on all 9 demo photos (≈12–17 s/photo on the sandbox's CPU-only WASM; WebGPU phones should be much faster) |
| 6. Multi-photo merge | ✅ done (best effort) | exact depth: ground-truth poses kept exactly. **Real model depth: ICP nudged the (exact) plan poses by up to ~17° / 0.7 m.** It trades rotation for the model's depth-scale errors. The renderer draws the active photo over the others, so the current view stays clean either way |
| 7. Floor-plan node graph UI | ✅ done | e2e: plan tap + chip navigation |
| 8. Gyro parallax | ✅ built, ⚠️ **not tried on a real phone** | desktop mouse-parallax path exercised; iOS permission flow is code-only |
| Access gate (added on request) | ✅ done | curl: locked by default, bogus Gemini key rejected |
| Gemini cost tracker | ✅ done | each Gemini button shows its last run's estimated cost and tokens, plus this device's running total (localStorage, with reset). Cached re-runs show as free. Rates in `lib/cost.ts` were checked against ai.google.dev pricing on 2026-09-24 |

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
2. **Sample listing: 36316 S Park Dr, Avon, OH 44011**: https://www.redfin.com/OH/Avon/36316-S-Park-Dr-44011/home/77239821 (the user's choice). Server import fails (WAF challenge, above). **Next: the user runs the bookmarklet on that page from Chrome on Android** against the deployed app, then reports how many photos arrived and whether any failed to download. Then run the full pipeline on real photos. This is the first real-world test of matching, merge and stereo comfort.
3. **Tune the merge on real photos.** Known issue from the demo: with model depth, ICP drifts from correct plan poses. Try, in order: (a) fit a per-photo depth scale/shift so the floor plane sits at camera height −1.5 m and walls match the plan's room box, *before* ICP; (b) tighten ICP bounds (currently ±20°/0.8 m) or require a larger overlap gain than +0.05; (c) compare against Gemini-estimated poses rather than exact ones, since ICP may still help there. Real photos have lens distortion, unknown FOV (assumed 75° horizontal) and non-metric depth. Look at `inlierRatio` in the `[room-model]` console.debug lines. If rooms look misaligned, try the per-room depth scale from printed dimensions first, before loosening the ICP bounds in `lib/merge.ts`.
4. **Replicate path: possible future improvement, not set up.** The user hasn't created a Replicate account, and on-device depth (Depth Anything V2 Small) is the default and works. Replicate would add the Large model on the server for sharper depth on slow phones, at a per-photo cost. To try it: set `REPLICATE_API_TOKEN` (Vercel env var, or a cloud-session API credential for `api.replicate.com` with header `Authorization`, prefix `Bearer`), then check `/api/depth` end to end. The model version is pinned in `lib/depth.ts`. If adopted, extend the cost tracker to Replicate's per-second billing.
5. **Real-phone pass.** Cross-eye comfort (Depth slider default of 1.0 may be too strong), iOS motion permission, landscape layout, WebGPU vs WASM depth speed.
6. **Open questions** from the brief are answered with defaults in the README. Revisit server-side caching (Vercel Blob/KV) if multi-device use matters.

## How to test

```bash
npm install            # .npmrc skips onnxruntime-node's native download (not needed)
npm test && npm run typecheck && npm run lint
npm run build && GEMINI_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1 npx next start -p 3100 &   # cloud session: real Gemini via the proxy
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
- **Playwright:** don't `npm i playwright` (a newer version wants its own browser download). If you do, launch with `executablePath: "/opt/pw-browsers/chromium"`.
- **Gemini cost** is estimated from `usageMetadata` (thinking tokens bill as output). Match-photo sends two images per call (photo + plan), ≈2.5k input tokens; the Pro model's thinking dominates the cost.
- **Monocular depth is relative.** Everything metric comes from assumptions (`DEFAULT_INTRINSICS` in `lib/geometry.ts`) plus the plan's printed room sizes.
