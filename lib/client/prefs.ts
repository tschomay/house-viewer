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
