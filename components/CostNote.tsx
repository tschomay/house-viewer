"use client";

import { formatUsd } from "@/lib/cost";
import { resetCost, useCostLedger, type CostAction } from "@/lib/client/cost";

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** One muted line under a Gemini button: what its last run cost, plus this device's running total. */
export default function CostNote({ action }: { action: CostAction }) {
  const { last, total } = useCostLedger();
  const run = last[action];
  if (!run && total.calls === 0) return null;
  return (
    <p className="small muted cost-note">
      {run && (
        <>
          Last run ≈ <strong>{formatUsd(run.usd)}</strong>
          {run.calls > 0 && ` · ${run.calls} call${run.calls === 1 ? "" : "s"}, ${k(run.inputTokens)} in / ${k(run.outputTokens)} out tokens`}
          {run.cachedHits > 0 && ` · ${run.cachedHits} from cache (free)`}
          {" · "}
        </>
      )}
      Gemini total on this device ≈ {formatUsd(total.usd)}{" "}
      <button className="linklike" onClick={resetCost}>reset</button>
    </p>
  );
}
