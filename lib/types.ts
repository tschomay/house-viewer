/** Shared domain types for the listing → tour pipeline. */

export type ImageKind = "photo" | "floorplan";
export type ImageSource = "import" | "upload";

/** An image the user is working with (downscaled JPEG, held client-side). */
export interface ListingImage {
  id: string; // sha-256 of the downscaled bytes — also the cache key
  kind: ImageKind;
  source: ImageSource;
  dataUrl: string; // image/jpeg data URL, max ~1600px on the long edge
  width: number;
  height: number;
  originalUrl?: string; // for imported images
  label?: string; // alt text / filename
}

/** Normalized 0..1 floor plan coordinates (x → right, y → down). */
export interface PlanPoint {
  x: number;
  y: number;
}

export interface Room {
  id: string;
  label: string;
  type: string; // kitchen, bedroom, bathroom, living, hallway, other...
  neighbors: string[];
  centroid: PlanPoint;
  /** Axis-aligned bounds on the floor plan, normalized 0..1. */
  bbox?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Approximate size in metres, if dimensions are printed on the plan. */
  sizeM?: { width: number; depth: number } | null;
}

export interface RoomGraph {
  rooms: Room[];
  /** Free-text caveats from the model (unreadable labels, multiple floors...). */
  notes?: string;
}

export type MatchStatus = "matched" | "low-confidence" | "unmatched" | "exterior";

export interface PhotoMatch {
  photoId: string;
  roomId: string | null;
  confidence: number; // 0..1
  /** Camera heading in degrees on the floor plan: 0 = up, 90 = right (clockwise). */
  headingDeg: number | null;
  /** Approximate camera position on the floor plan, if the model could tell. */
  cameraPosition: PlanPoint | null;
  reasoning: string;
  status: MatchStatus;
  /** True when the user reassigned this photo by hand. */
  manual?: boolean;
  /** Visual signature from the one-call sort (wall colour, flooring, ceiling). */
  appearance?: string;
  /** Camera heading/position were set by hand on the map; the placement pass keeps them. */
  manualPose?: boolean;
  /** Camera heading/position came from the per-room placement pass (all of a room's photos judged together). */
  placed?: boolean;
  /** Placement pass: what Gemini used to place the camera. */
  placementNote?: string;
  /** Placement pass: Gemini thinks this photo shows a different room. */
  suggestedRoomId?: string | null;
}

export interface DepthMap {
  photoId: string;
  width: number;
  height: number;
  /** Grayscale PNG data URL. Bright = near (relative inverse depth, Depth-Anything style). */
  dataUrl: string;
  source: "browser" | "replicate" | "heuristic" | "truth";
}

export interface ImportResult {
  ok: boolean;
  /** What we tried, for display ("Fetched listing page", "Blocked (403)"...). */
  steps: string[];
  resolvedUrl?: string;
  photos: { url: string; alt?: string }[];
  floorPlans: { url: string; alt?: string }[];
  error?: string;
}

/** Below this, a Gemini match is shown in the "needs review" tray. */
export const MATCH_CONFIDENCE_THRESHOLD = 0.55;
