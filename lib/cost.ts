/**
 * Gemini cost estimates, from the token counts the API reports on every call.
 *
 * Prices are USD per 1M tokens (paid tier, standard, non-batch). Output
 * includes thinking tokens, which Gemini bills as output. Images are billed as
 * input tokens and are already counted in the prompt token total.
 * Checked against https://ai.google.dev/gemini-api/docs/pricing on 2026-09-24.
 * Rates change: override with GEMINI_PRICE_INPUT_PER_M / GEMINI_PRICE_OUTPUT_PER_M.
 */

export interface GeminiUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

interface Rate {
  input: number;
  output: number;
  /** Rates for prompts over 200k tokens, where the model has a long-context tier. */
  long?: { input: number; output: number };
}

const LONG_CONTEXT_TOKENS = 200_000;

// Most specific prefix first.
const RATES: [prefix: string, rate: Rate][] = [
  ["gemini-3.1-pro", { input: 2, output: 12, long: { input: 4, output: 18 } }],
  ["gemini-3-pro", { input: 2, output: 12, long: { input: 4, output: 18 } }],
  ["gemini-3-flash", { input: 0.5, output: 3 }],
  ["gemini-2.5-pro", { input: 1.25, output: 10, long: { input: 2.5, output: 15 } }],
  ["gemini-2.5-flash-lite", { input: 0.1, output: 0.4 }],
  ["gemini-2.5-flash", { input: 0.3, output: 2.5 }],
];

// Unknown models are priced like the default Pro model rather than shown as free.
const FALLBACK: Rate = RATES[0][1];

export function geminiRate(model: string, env: Record<string, string | undefined> = {}): Rate {
  const base = RATES.find(([prefix]) => model.startsWith(prefix))?.[1] ?? FALLBACK;
  const input = Number(env.GEMINI_PRICE_INPUT_PER_M);
  const output = Number(env.GEMINI_PRICE_OUTPUT_PER_M);
  if (input > 0 && output > 0) return { input, output };
  return base;
}

/** Shape of `usageMetadata` on a generateContent response (fields we need). */
export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}

export function geminiUsage(model: string, meta: UsageMetadata | undefined, env: Record<string, string | undefined> = {}): GeminiUsage {
  const inputTokens = meta?.promptTokenCount ?? 0;
  const outputTokens = (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
  const rate = geminiRate(model, env);
  const r = inputTokens > LONG_CONTEXT_TOKENS && rate.long ? rate.long : rate;
  const usd = (inputTokens * r.input + outputTokens * r.output) / 1_000_000;
  return { model, inputTokens, outputTokens, usd };
}

export function sumUsage(items: GeminiUsage[]): Omit<GeminiUsage, "model"> & { calls: number } {
  return items.reduce(
    (a, u) => ({ calls: a.calls + 1, inputTokens: a.inputTokens + u.inputTokens, outputTokens: a.outputTokens + u.outputTokens, usd: a.usd + u.usd }),
    { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
  );
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}
