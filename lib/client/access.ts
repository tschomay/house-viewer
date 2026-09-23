/**
 * Credentials for the server's access gate (see lib/access.ts), kept in this
 * browser's localStorage. Sent as headers on every API call.
 */
export interface AccessCreds {
  password?: string;
  geminiKey?: string;
  replicateToken?: string;
}

const KEY = "house-viewer:access";
const EVENT = "house-viewer:access-changed";

export function getCreds(): AccessCreds {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as AccessCreds;
  } catch {
    return {};
  }
}

export function setCreds(c: AccessCreds): void {
  const clean = Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === "string" && v.trim())) as AccessCreds;
  try {
    localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    /* storage blocked: creds last for this page only */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function onCredsChange(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

export function authHeaders(): Record<string, string> {
  const c = typeof window === "undefined" ? {} : getCreds();
  const h: Record<string, string> = {};
  if (c.password) h["x-access-password"] = c.password;
  if (c.geminiKey) h["x-gemini-key"] = c.geminiKey;
  if (c.replicateToken) h["x-replicate-token"] = c.replicateToken;
  return h;
}

export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers as Record<string, string>) } });
}
