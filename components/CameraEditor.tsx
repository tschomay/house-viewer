"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { ListingImage, PhotoMatch, PlanPoint, RoomGraph } from "@/lib/types";

const FloorPlanGraph = dynamic(() => import("@/components/FloorPlanGraph"), { ssr: false });

interface Props {
  graph: RoomGraph;
  floorPlan: ListingImage | null;
  photo: ListingImage;
  match: PhotoMatch;
  onSave: (pose: { cameraPosition: PlanPoint; headingDeg: number }) => void;
  onClose: () => void;
}

/**
 * Set where a photo was taken by hand: tap the plan to move the camera, turn
 * the dial to aim it. Free, and it overrides whatever Gemini guessed. The
 * placement pass treats the result as fixed.
 */
export default function CameraEditor({ graph, floorPlan, photo, match, onSave, onClose }: Props) {
  const room = graph.rooms.find((r) => r.id === match.roomId);
  const [pos, setPos] = useState<PlanPoint>(match.cameraPosition ?? room?.centroid ?? { x: 0.5, y: 0.5 });
  const [heading, setHeading] = useState(Math.round(match.headingDeg ?? 0));
  const turn = (d: number) => setHeading((h) => (((h + d) % 360) + 360) % 360);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "#0b0c0f", display: "flex", flexDirection: "column", overflow: "auto" }}>
      <div className="controls">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>Set camera · {room?.label ?? "?"}</strong>
          <button className="btn small" onClick={onClose}>Cancel</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Tap the plan where the photographer stood, then turn the arrow until it points the way the photo looks.
        </p>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo.dataUrl} alt={photo.label ?? ""} style={{ width: "100%", maxHeight: "32vh", objectFit: "contain", background: "#000" }} />
      <div style={{ padding: 8 }}>
        <FloorPlanGraph
          graph={graph}
          floorPlan={floorPlan}
          photoCounts={{}}
          current={match.roomId}
          onSelect={() => {}}
          onPlanTap={setPos}
          height={300}
          cameras={[{ ...pos, headingDeg: heading }]}
        />
      </div>
      <div className="controls">
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small" onClick={() => turn(-15)} aria-label="Turn left">↺ 15°</button>
          <input
            className="grow"
            type="range"
            min={0}
            max={359}
            value={heading}
            onChange={(e) => setHeading(Number(e.target.value))}
            aria-label="Camera direction"
          />
          <button className="btn small" onClick={() => turn(15)} aria-label="Turn right">15° ↻</button>
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="small muted">Facing {heading}° on the plan (0° = up)</span>
          <button className="btn primary" onClick={() => onSave({ cameraPosition: pos, headingDeg: heading })}>
            Save camera
          </button>
        </div>
      </div>
    </div>
  );
}
