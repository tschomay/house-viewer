/**
 * Running Gemini spend on this device, kept in localStorage. Only real API
 * calls are recorded: results served from the IndexedDB cache cost nothing.
 */
import { useSyncExternalStore } from "react";
import type { GeminiUsage } from "../cost";

export type CostAction = "graph" | "match" | "place";

export interface CostRun {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** Results served from cache during this run (free). */
  cachedHits: number;
  at: number;
}

export interface CostLedger {
  total: { calls: number; usd: number };
  last: Partial<Record<CostAction, CostRun>>;
}

const KEY = "house-viewer:gemini-cost";
const EVENT = "house-viewer:gemini-cost-changed";
const EMPTY: CostLedger = { total: { calls: 0, usd: 0 }, last: {} };

let snapshot: CostLedger | null = null;

function read(): CostLedger {
  if (snapshot) return snapshot;
  try {
    snapshot = { ...EMPTY, ...(JSON.parse(localStorage.getItem(KEY) ?? "null") as CostLedger | null) };
  } catch {
    snapshot = EMPTY;
  }
  return snapshot;
}

function write(next: CostLedger): void {
  snapshot = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: the tally lasts for this page only */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Start a button's run: its "last run" line resets to zero. */
export function beginRun(action: CostAction): void {
  const l = read();
  write({ ...l, last: { ...l.last, [action]: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, cachedHits: 0, at: Date.now() } } });
}

/** Add one API call's usage (or a free cache hit, when usage is null) to the current run and the total. */
export function recordUsage(action: CostAction, usage: GeminiUsage | null | undefined): void {
  const l = read();
  const run = l.last[action] ?? { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, cachedHits: 0, at: Date.now() };
  const next: CostRun = usage
    ? { ...run, calls: run.calls + 1, inputTokens: run.inputTokens + usage.inputTokens, outputTokens: run.outputTokens + usage.outputTokens, usd: run.usd + usage.usd }
    : { ...run, cachedHits: run.cachedHits + 1 };
  write({
    total: usage ? { calls: l.total.calls + 1, usd: l.total.usd + usage.usd } : l.total,
    last: { ...l.last, [action]: next },
  });
}

export function resetCost(): void {
  write(EMPTY);
}

function subscribe(fn: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      snapshot = null;
      fn();
    }
  };
  window.addEventListener(EVENT, fn);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function useCostLedger(): CostLedger {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
