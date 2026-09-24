"use client";

import { useEffect, useState } from "react";
import StereoViewer, { type StereoLayout } from "./StereoViewer";
import StereoControls from "./StereoControls";
import { usePairWidth, usePref } from "@/lib/client/prefs";
import { buildLayer, type RoomModel } from "@/lib/client/room-model";
import { DEFAULT_INTRINSICS, IDENTITY_POSE } from "@/lib/geometry";
import type { DepthMap, ListingImage } from "@/lib/types";

/** Full-screen single-photo stereo check (build step 5: does the parallax look right?). */
export default function StereoTest({ photo, depth, onClose }: { photo: ListingImage; depth: DepthMap; onClose: () => void }) {
  const [model, setModel] = useState<RoomModel | null>(null);
  const [layout, setLayout] = usePref<StereoLayout>("layout", "cross");
  const [strength, setStrength] = usePref<number>("strength", 1);
  const [pairWidth, setPairWidth] = usePairWidth();

  useEffect(() => {
    let alive = true;
    buildLayer(photo, depth, DEFAULT_INTRINSICS).then((l) => {
      if (!alive) return;
      setModel({
        room: { id: "test", label: photo.label ?? "Photo", type: "other", neighbors: [], centroid: { x: 0, y: 0 } },
        mode: "single",
        depthSource: depth.source,
        layers: [{ ...l, pose: IDENTITY_POSE, registered: false, inlierRatio: 0 }],
      });
    });
    return () => {
      alive = false;
    };
  }, [photo, depth]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "#0b0c0f", display: "flex", flexDirection: "column" }}>
      <div className="controls">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>{photo.label ?? "Stereo test"}</strong>
          <button className="btn small" onClick={onClose}>Close</button>
        </div>
        <StereoControls layout={layout} setLayout={setLayout} strength={strength} setStrength={setStrength} pairWidth={pairWidth} setPairWidth={setPairWidth} />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {model ? (
          <StereoViewer model={model} layout={layout} strength={strength} pairWidth={pairWidth} activeLayer={0} gyro={false} />
        ) : (
          <div className="center-msg"><span className="spinner" /></div>
        )}
      </div>
    </div>
  );
}
