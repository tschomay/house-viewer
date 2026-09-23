"use client";

import type { StereoLayout } from "./StereoViewer";

const LAYOUTS: { id: StereoLayout; label: string; title: string }[] = [
  { id: "cross", label: "Cross-eye", title: "Side-by-side, eyes crossed (hold phone ~30 cm away)" },
  { id: "parallel", label: "Parallel", title: "Side-by-side for parallel viewing or a cardboard viewer" },
  { id: "wiggle", label: "Wiggle", title: "Alternates the two eye views; depth without any eye tricks" },
  { id: "mono", label: "Flat", title: "Single view, with motion parallax only" },
];

export default function StereoControls({
  layout,
  setLayout,
  strength,
  setStrength,
}: {
  layout: StereoLayout;
  setLayout: (l: StereoLayout) => void;
  strength: number;
  setStrength: (s: number) => void;
}) {
  return (
    <div className="row" style={{ justifyContent: "space-between" }}>
      <div className="seg" role="group" aria-label="Stereo layout">
        {LAYOUTS.map((l) => (
          <button key={l.id} aria-pressed={layout === l.id} title={l.title} onClick={() => setLayout(l.id)}>
            {l.label}
          </button>
        ))}
      </div>
      {layout !== "mono" && (
        <label className="row small muted" style={{ gap: 6 }}>
          Depth
          <input type="range" min={0.3} max={3} step={0.1} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
        </label>
      )}
    </div>
  );
}
