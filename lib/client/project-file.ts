/**
 * Save the whole project (photos, floor plan, room map, sorting, camera
 * placements) as one JSON file, and load it back. Projects otherwise live only
 * in this browser's IndexedDB: this moves one to another device, or hands a
 * real listing to someone debugging it. Depth maps are left out (they're
 * recomputed on device); everything Gemini produced is kept, so nothing is
 * re-billed.
 */
import type { Project } from "./project";

const FORMAT = "house-viewer-project";

export function exportProject(project: Project): void {
  const payload = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), project: { ...project, depth: {} } };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const name = (project.listingInput || "project").replace(/^https?:\/\/(www\.)?/, "").replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
  a.href = url;
  a.download = `house-viewer-${name}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function readProjectFile(file: File): Promise<Project> {
  let parsed: { format?: unknown; project?: Partial<Project> };
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const p = parsed.project;
  if (parsed.format !== FORMAT || !p || !Array.isArray(p.images)) throw new Error("That isn't a House Viewer project file.");
  return { ...(p as Project), depth: p.depth ?? {} };
}
