import { describe, expect, it } from "vitest";
import { formatUsd, geminiRate, geminiUsage, sumUsage } from "@/lib/cost";

describe("geminiUsage", () => {
  it("bills thinking tokens as output", () => {
    const u = geminiUsage("gemini-3.1-pro-preview", { promptTokenCount: 100_000, candidatesTokenCount: 40_000, thoughtsTokenCount: 60_000 });
    expect(u).toMatchObject({ inputTokens: 100_000, outputTokens: 100_000 });
    expect(u.usd).toBeCloseTo(0.1 * (2 + 12));
  });

  it("uses the long-context tier over 200k prompt tokens", () => {
    expect(geminiUsage("gemini-3.1-pro-preview", { promptTokenCount: 250_000 }).usd).toBeCloseTo(0.25 * 4);
  });

  it("matches the most specific model prefix", () => {
    expect(geminiRate("gemini-2.5-flash-lite").input).toBe(0.1);
    expect(geminiRate("gemini-2.5-flash").input).toBe(0.3);
  });

  it("lets env override the rates and falls back for unknown models", () => {
    expect(geminiRate("gemini-9-ultra")).toMatchObject({ input: 2, output: 12 });
    expect(geminiRate("gemini-3.1-pro-preview", { GEMINI_PRICE_INPUT_PER_M: "1", GEMINI_PRICE_OUTPUT_PER_M: "5" })).toEqual({ input: 1, output: 5 });
  });

  it("bills generated image tokens at the image rate", () => {
    const u = geminiUsage("gemini-3.1-flash-image", {
      promptTokenCount: 2000,
      candidatesTokenCount: 1500,
      candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
    });
    expect(u.usd).toBeCloseTo((2000 * 0.5 + 380 * 3 + 1120 * 60) / 1e6);
    expect(geminiRate("gemini-3.1-flash-lite-image").imageOutput).toBe(30);
  });

  it("treats missing metadata as zero", () => {
    expect(geminiUsage("gemini-3.1-pro-preview", undefined).usd).toBe(0);
  });
});

describe("sumUsage / formatUsd", () => {
  it("sums calls", () => {
    const a = geminiUsage("gemini-3.1-pro-preview", { promptTokenCount: 1000, candidatesTokenCount: 100 });
    expect(sumUsage([a, a])).toMatchObject({ calls: 2, inputTokens: 2000, outputTokens: 200 });
  });
  it("formats small amounts with more precision", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00312)).toBe("$0.0031");
    expect(formatUsd(0.0456)).toBe("$0.046");
    expect(formatUsd(3.1)).toBe("$3.10");
  });
});
