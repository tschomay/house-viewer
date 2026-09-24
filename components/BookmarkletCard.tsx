"use client";

import { useState, useSyncExternalStore } from "react";
import { buildBookmarklet } from "@/lib/bookmarklet";

const noop = () => () => {};

/** Setup card for the "Send to House Viewer" bookmarklet (see lib/bookmarklet.ts). */
export default function BookmarkletCard() {
  // The bookmarklet points back at whichever deployment served this page.
  const origin = useSyncExternalStore(noop, () => window.location.origin, () => null);
  const code = origin ? buildBookmarklet(origin) : "";
  const [copied, setCopied] = useState<boolean | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Import with a bookmark</h2>
        <span className="badge ok">recommended</span>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Listing sites block our server, but not you. This bookmark runs on the listing page in your own browser, picks up the
        photo links and brings them back here. Set it up once:
      </p>
      <ol className="small steps-list">
        <li>
          <button className="btn small" onClick={copy} disabled={!code}>
            Copy bookmark code
          </button>{" "}
          {copied === true && <span className="muted">Copied.</span>}
          {copied === false && <span className="muted">Copy blocked: select the code below and copy it by hand.</span>}
        </li>
        <li>In Chrome, bookmark this page (⋮ menu → ☆).</li>
        <li>
          Open ⋮ → <strong>Bookmarks</strong>, long-press the new bookmark → <strong>Edit</strong>. Name it{" "}
          <strong>House Viewer</strong> and paste the code over the URL.
        </li>
        <li>
          On a listing, tap the address bar, type <strong>House Viewer</strong> and tap the bookmark in the suggestions. Opening
          it from the Bookmarks screen won&apos;t run it.
        </li>
      </ol>
      <p className="small muted">
        Only a few photos came through? Open the listing&apos;s photo gallery first, then run the bookmark again. The floor
        plan is often just one of the photos: mark it with &quot;Set as plan&quot; below.
      </p>
      <details>
        <summary className="small">Show the code</summary>
        <textarea className="input raw" readOnly rows={4} value={code} onFocus={(e) => e.currentTarget.select()} style={{ width: "100%" }} />
      </details>
    </section>
  );
}
