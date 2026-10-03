"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { DepthMap, ImportResult, ListingImage, PhotoMatch, RoomGraph, WallArt } from "../types";
import { applyPlacement, type Placement } from "../placement";
import { idbGet, idbSet } from "./idb";
import { apiFetch, onCredsChange } from "./access";
import { composePlans } from "./images";

export interface Project {
  listingInput: string;
  importResult: ImportResult | null;
  images: ListingImage[];
  graph: RoomGraph | null;
  graphRaw: string | null;
  graphSource: "gemini" | "demo" | null;
  matches: Record<string, PhotoMatch>;
  matchRaw: Record<string, string>;
  depth: Record<string, DepthMap>;
  /** AI wall textures for the 3D fly-through, by room id. */
  wallArt: Record<string, WallArt>;
  isDemo: boolean;
}

const EMPTY: Project = {
  listingInput: "",
  importResult: null,
  images: [],
  graph: null,
  graphRaw: null,
  graphSource: null,
  matches: {},
  matchRaw: {},
  depth: {},
  wallArt: {},
  isDemo: false,
};

type Action =
  | { type: "load"; project: Project }
  | { type: "reset" }
  | { type: "input"; value: string }
  | { type: "import"; result: ImportResult | null }
  | { type: "addImages"; images: ListingImage[] }
  | { type: "removeImage"; id: string }
  | { type: "setKind"; id: string; kind: ListingImage["kind"] }
  /** Move a floor plan one level earlier (-1) or later (+1) among the floor plans. */
  | { type: "movePlan"; id: string; dir: -1 | 1 }
  | { type: "graph"; graph: RoomGraph | null; raw: string | null; source: Project["graphSource"] }
  | { type: "match"; match: PhotoMatch; raw?: string }
  | { type: "placement"; roomId: string; placement: Placement }
  | { type: "depth"; depth: DepthMap }
  | { type: "wallArt"; art: WallArt }
  | { type: "clearWallArt" }
  | { type: "replace"; project: Partial<Project> };

/** The floor plans changed: the plan sheet is a different image, so the room graph and every match are stale. */
const PLAN_CHANGED = { graph: null, graphRaw: null, graphSource: null, matches: {} } satisfies Partial<Project>;

function reducer(state: Project, action: Action): Project {
  switch (action.type) {
    case "load":
      return { ...EMPTY, ...action.project };
    case "reset":
      return EMPTY;
    case "input":
      return { ...state, listingInput: action.value };
    case "import":
      return { ...state, importResult: action.result };
    case "addImages": {
      const have = new Set(state.images.map((i) => i.id));
      const fresh = action.images.filter((i) => !have.has(i.id) && have.add(i.id));
      return { ...state, images: [...state.images, ...fresh], ...(fresh.some((i) => i.kind === "floorplan") ? PLAN_CHANGED : {}) };
    }
    case "removeImage": {
      const matches = { ...state.matches };
      const depth = { ...state.depth };
      delete matches[action.id];
      delete depth[action.id];
      const removed = state.images.find((i) => i.id === action.id);
      return {
        ...state,
        images: state.images.filter((i) => i.id !== action.id),
        matches,
        depth,
        // A different floor plan invalidates the room graph and every match.
        ...(removed?.kind === "floorplan" ? PLAN_CHANGED : {}),
      };
    }
    case "setKind":
      return {
        ...state,
        images: state.images.map((i) => (i.id === action.id ? { ...i, kind: action.kind } : i)),
        ...PLAN_CHANGED,
      };
    case "movePlan": {
      const plans = state.images.filter((i) => i.kind === "floorplan");
      const at = plans.findIndex((i) => i.id === action.id);
      const other = plans[at + action.dir];
      if (at < 0 || !other) return state;
      const a = state.images.indexOf(plans[at]), b = state.images.indexOf(other);
      const images = [...state.images];
      [images[a], images[b]] = [images[b], images[a]];
      return { ...state, images, ...PLAN_CHANGED };
    }
    case "graph":
      return { ...state, graph: action.graph, graphRaw: action.raw, graphSource: action.source, matches: {}, matchRaw: {}, wallArt: {} };
    case "match":
      return {
        ...state,
        matches: { ...state.matches, [action.match.photoId]: action.match },
        matchRaw: action.raw !== undefined ? { ...state.matchRaw, [action.match.photoId]: action.raw } : state.matchRaw,
      };
    case "placement": {
      const m = state.matches[action.placement.photoId];
      // Skip if the photo was moved to another room while the call was running.
      if (!m || m.roomId !== action.roomId) return state;
      return { ...state, matches: { ...state.matches, [m.photoId]: applyPlacement(m, action.placement) } };
    }
    case "depth":
      return { ...state, depth: { ...state.depth, [action.depth.photoId]: action.depth } };
    case "wallArt":
      return { ...state, wallArt: { ...state.wallArt, [action.art.roomId]: action.art } };
    case "clearWallArt":
      return { ...state, wallArt: {} };
    case "replace":
      return { ...state, ...action.project };
  }
}

interface Ctx {
  project: Project;
  ready: boolean;
  dispatch: (a: Action) => void;
  photos: ListingImage[];
  /** The floor plan images, one per level, in level order. */
  floorPlans: ListingImage[];
  /**
   * The plan everything maps onto: the only floor plan, or all of them laid
   * out on one sheet (see composePlans). Null when there's no floor plan.
   */
  floorPlan: ListingImage | null;
}

const ProjectContext = createContext<Ctx | null>(null);
const KEY = "project:current";

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, dispatch] = useReducer(reducer, EMPTY);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    idbGet<Project>(KEY).then((saved) => {
      if (saved) dispatch({ type: "load", project: saved });
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void idbSet(KEY, project), 400);
  }, [project, loaded]);

  const photos = useMemo(() => project.images.filter((i) => i.kind === "photo"), [project.images]);
  const floorPlans = useMemo(() => project.images.filter((i) => i.kind === "floorplan"), [project.images]);
  const plansKey = floorPlans.map((p) => p.id).join(",");
  // Several plans are drawn onto one sheet; `ready` waits for it so pages never see a missing plan.
  const [sheet, setSheet] = useState<{ key: string; image: ListingImage | null }>({ key: "", image: null });
  useEffect(() => {
    if (floorPlans.length <= 1 || sheet.key === plansKey) return;
    let live = true;
    composePlans(floorPlans)
      .catch(() => floorPlans[0])
      .then((image) => live && setSheet({ key: plansKey, image }));
    return () => {
      live = false;
    };
  }, [floorPlans, plansKey, sheet.key]);
  const sheetReady = floorPlans.length <= 1 || sheet.key === plansKey;
  const floorPlan = floorPlans.length <= 1 ? (floorPlans[0] ?? null) : sheetReady ? sheet.image : null;
  const ready = loaded && sheetReady;
  const stableDispatch = useCallback((a: Action) => dispatch(a), []);

  return (
    <ProjectContext.Provider value={{ project, ready, dispatch: stableDispatch, photos, floorPlans, floorPlan }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): Ctx {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used inside <ProjectProvider>");
  return ctx;
}

export interface ServerStatus {
  access: { ok: boolean; via?: "password" | "own-key" | "dev"; error?: string };
  gate: { passwordConfigured: boolean; devOpen: boolean };
  gemini: boolean;
  geminiModel: string;
  replicate: boolean;
  depthModel: string;
}

export function useServerStatus(): ServerStatus | null {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  useEffect(() => {
    const load = () =>
      apiFetch("/api/status")
        .then((r) => r.json())
        .then(setStatus)
        .catch(() =>
          setStatus({
            access: { ok: false, error: "Server unreachable" },
            gate: { passwordConfigured: false, devOpen: false },
            gemini: false,
            geminiModel: "?",
            replicate: false,
            depthModel: "?",
          }),
        );
    void load();
    return onCredsChange(load);
  }, []);
  return status;
}
