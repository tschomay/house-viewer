"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { DepthMap, ImportResult, ListingImage, PhotoMatch, RoomGraph } from "../types";
import { idbGet, idbSet } from "./idb";
import { apiFetch, onCredsChange } from "./access";

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
  | { type: "graph"; graph: RoomGraph | null; raw: string | null; source: Project["graphSource"] }
  | { type: "match"; match: PhotoMatch; raw?: string }
  | { type: "depth"; depth: DepthMap }
  | { type: "replace"; project: Partial<Project> };

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
      return { ...state, images: [...state.images, ...fresh] };
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
        ...(removed?.kind === "floorplan" ? { graph: null, graphRaw: null, graphSource: null, matches: {} } : {}),
      };
    }
    case "setKind":
      return {
        ...state,
        images: state.images.map((i) => (i.id === action.id ? { ...i, kind: action.kind } : i)),
        graph: null,
        graphRaw: null,
        graphSource: null,
        matches: {},
      };
    case "graph":
      return { ...state, graph: action.graph, graphRaw: action.raw, graphSource: action.source, matches: {}, matchRaw: {} };
    case "match":
      return {
        ...state,
        matches: { ...state.matches, [action.match.photoId]: action.match },
        matchRaw: action.raw !== undefined ? { ...state.matchRaw, [action.match.photoId]: action.raw } : state.matchRaw,
      };
    case "depth":
      return { ...state, depth: { ...state.depth, [action.depth.photoId]: action.depth } };
    case "replace":
      return { ...state, ...action.project };
  }
}

interface Ctx {
  project: Project;
  ready: boolean;
  dispatch: (a: Action) => void;
  photos: ListingImage[];
  floorPlan: ListingImage | null;
}

const ProjectContext = createContext<Ctx | null>(null);
const KEY = "project:current";

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, dispatch] = useReducer(reducer, EMPTY);
  const [ready, setReady] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    idbGet<Project>(KEY).then((saved) => {
      if (saved) dispatch({ type: "load", project: saved });
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void idbSet(KEY, project), 400);
  }, [project, ready]);

  const photos = useMemo(() => project.images.filter((i) => i.kind === "photo"), [project.images]);
  const floorPlan = useMemo(() => project.images.find((i) => i.kind === "floorplan") ?? null, [project.images]);
  const stableDispatch = useCallback((a: Action) => dispatch(a), []);

  return (
    <ProjectContext.Provider value={{ project, ready, dispatch: stableDispatch, photos, floorPlan }}>
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
