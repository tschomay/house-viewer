import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Access gate for everything that spends API credits or fetches arbitrary
 * URLs server-side. Two ways in:
 *
 *  1. `x-access-password` matching the ACCESS_PASSWORD env var: unlocks the
 *     server's own GEMINI_API_KEY / REPLICATE_API_TOKEN (the owner's path).
 *  2. `x-gemini-key`: a visitor's own Gemini key. It is checked against
 *     Google once (then cached briefly) and used only for that visitor's
 *     requests. `x-replicate-token` may come along with it.
 *
 * With neither, requests are refused, except in `next dev` when no
 * ACCESS_PASSWORD is set, so local development stays frictionless.
 */

export interface Credentials {
  geminiKey: string | null;
  replicateToken: string | null;
  via: "password" | "own-key" | "dev";
}

export class AccessError extends Error {
  status = 401;
}

const validated = new Map<string, number>(); // sha256(key) → expiry ms
const VALID_FOR_MS = 30 * 60 * 1000;

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ha = Buffer.from(sha(a)), hb = Buffer.from(sha(b));
  return timingSafeEqual(ha, hb);
}

async function geminiKeyIsValid(key: string): Promise<boolean> {
  const h = sha(key);
  const exp = validated.get(h);
  if (exp && exp > Date.now()) return true;
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  if (validated.size > 5000) validated.clear();
  validated.set(h, Date.now() + VALID_FOR_MS);
  return true;
}

export function gateConfig() {
  return {
    passwordConfigured: Boolean(process.env.ACCESS_PASSWORD),
    devOpen: !process.env.ACCESS_PASSWORD && process.env.NODE_ENV === "development",
  };
}

export async function authorize(req: Request): Promise<Credentials> {
  const password = req.headers.get("x-access-password");
  const ownKey = req.headers.get("x-gemini-key")?.trim();
  const ownReplicate = req.headers.get("x-replicate-token")?.trim() || null;
  const serverPassword = process.env.ACCESS_PASSWORD;

  if (password && serverPassword && safeEqual(password, serverPassword)) {
    return {
      geminiKey: process.env.GEMINI_API_KEY ?? null,
      replicateToken: ownReplicate ?? process.env.REPLICATE_API_TOKEN ?? null,
      via: "password",
    };
  }
  if (ownKey) {
    if (await geminiKeyIsValid(ownKey)) return { geminiKey: ownKey, replicateToken: ownReplicate, via: "own-key" };
    throw new AccessError("That Gemini API key was rejected by Google.");
  }
  if (gateConfig().devOpen) {
    return {
      geminiKey: process.env.GEMINI_API_KEY ?? null,
      replicateToken: ownReplicate ?? process.env.REPLICATE_API_TOKEN ?? null,
      via: "dev",
    };
  }
  throw new AccessError(password ? "Wrong access password." : "Locked: enter the access password or your own Gemini API key.");
}

/** Wrap a route handler: authorize, or answer 401 JSON. */
export function gated(handler: (req: Request, creds: Credentials) => Promise<Response>) {
  return async (req: Request) => {
    let creds: Credentials;
    try {
      creds = await authorize(req);
    } catch (e) {
      if (e instanceof AccessError) return Response.json({ error: e.message, locked: true }, { status: 401 });
      throw e;
    }
    return handler(req, creds);
  };
}
