/**
 * Tiny IndexedDB key/value store. Used to cache per-image Gemini/depth results
 * (keyed by image hash) and to persist the current project across reloads.
 * Every call degrades to a no-op if IndexedDB is unavailable (private mode).
 */
const DB = "house-viewer";
const STORE = "kv";

let dbp: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbp ??= new Promise((resolve) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbp;
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => resolve(undefined);
  });
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await open();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function idbDelete(key: string): Promise<void> {
  const db = await open();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** Memoize an async computation in IndexedDB under `key`. */
export async function cached<T>(key: string, compute: () => Promise<T>, enabled = true): Promise<T> {
  if (enabled) {
    const hit = await idbGet<T>(key);
    if (hit !== undefined) return hit;
  }
  const value = await compute();
  await idbSet(key, value);
  return value;
}
