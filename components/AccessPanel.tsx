"use client";

import { useState } from "react";
import { getCreds, setCreds } from "@/lib/client/access";
import type { ServerStatus } from "@/lib/client/project";

/**
 * Unlock the server-side features (Gemini, Replicate, auto-import) with either
 * the owner's access password or your own Gemini key. The demo house and
 * on-device depth work without either.
 */
export default function AccessPanel({ status }: { status: ServerStatus | null }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [replicateToken, setReplicateToken] = useState("");

  const toggle = () => {
    if (!open) {
      const c = getCreds();
      setPassword(c.password ?? "");
      setGeminiKey(c.geminiKey ?? "");
      setReplicateToken(c.replicateToken ?? "");
    }
    setOpen(!open);
  };

  const ok = status?.access.ok;
  const via = status?.access.via;
  const label = !status
    ? "Checking access…"
    : ok
      ? via === "password"
        ? "Unlocked with access password"
        : via === "own-key"
          ? "Using your own Gemini key"
          : "Dev mode: no password set"
      : "Locked: AI steps and auto-import need access";

  return (
    <section className="card">
      <div className="card-head">
        <h2>Access</h2>
        <span className={`badge ${ok ? "ok" : "warn"}`}>{ok ? "unlocked" : status ? "locked" : "…"}</span>
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="small muted">
          {label}
          {status && !ok && status.access.error && status.access.error.startsWith("Wrong") ? ` (${status.access.error})` : ""}
          {status?.access.error?.includes("rejected") ? ` (${status.access.error})` : ""}
        </span>
        <button className="btn small" onClick={toggle}>{open ? "Hide" : ok ? "Change" : "Unlock"}</button>
      </div>
      {open && (
        <form
          style={{ display: "grid", gap: 8, marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            setCreds({ password, geminiKey, replicateToken });
            setOpen(false);
          }}
        >
          <label className="small muted">
            Access password (from the owner of this site)
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <div className="small muted" style={{ textAlign: "center" }}>or use your own keys</div>
          <label className="small muted">
            Your Gemini API key (<a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">get one</a>)
            <input className="input" type="password" autoComplete="off" value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} />
          </label>
          <label className="small muted">
            Replicate token (optional, for the larger server-side depth model)
            <input className="input" type="password" autoComplete="off" value={replicateToken} onChange={(e) => setReplicateToken(e.target.value)} />
          </label>
          <p className="small muted" style={{ margin: 0 }}>
            Stored only in this browser and sent with each request. Keys are never saved on the server.
          </p>
          <div className="row">
            <button className="btn primary" type="submit">Save</button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                setPassword("");
                setGeminiKey("");
                setReplicateToken("");
                setCreds({});
              }}
            >
              Clear
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
