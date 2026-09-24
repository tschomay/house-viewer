/**
 * Small per-device viewing preferences (stereo width, depth, layout) kept in
 * localStorage, read through useSyncExternalStore so server and first client
 * render agree.
 */
import { useCallback, useSyncExternalStore } from "react";

const PREFIX = "house-viewer:pref:";
const EVENT = "house-viewer:pref-changed";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function subscribe(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  window.addEventListener("storage", fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("storage", fn);
  };
}

/** "landscape" or "portrait", live. */
export function useOrientation(): "landscape" | "portrait" {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia("(orientation: landscape)");
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    () => (window.matchMedia("(orientation: landscape)").matches ? "landscape" : "portrait"),
    () => "portrait",
  );
}

/**
 * Stereo pair width, remembered separately for portrait and landscape: a
 * landscape phone is much wider than the eyes are apart, portrait is not.
 */
export function usePairWidth(): [number, (w: number) => void] {
  const orientation = useOrientation();
  return usePref<number>(`pairWidth:${orientation}`, orientation === "landscape" ? 0.7 : 1);
}

export function usePref<T extends string | number | boolean>(key: string, fallback: T): [T, (v: T) => void] {
  const value = useSyncExternalStore(subscribe, () => read(key, fallback), () => fallback);
  const set = useCallback(
    (v: T) => {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(v));
      } catch {
        /* storage blocked: the setting lasts until the page reloads */
      }
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  return [value, set];
}
