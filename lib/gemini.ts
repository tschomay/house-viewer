import "server-only";
import { GoogleGenAI, PartMediaResolutionLevel, type Part } from "@google/genai";
import { geminiUsage, type GeminiUsage } from "./cost";
import { PLACEMENT_SCHEMA, placementPrompt, type FixedCamera } from "./placement";
import { SORT_SCHEMA, sortPrompt, type SortPhotoInput } from "./sorting";
import type { Room, RoomGraph } from "./types";
import { WALL_ART_ASPECT, wallArtPrompt, type WallArtRoom } from "./wall-art";

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";
/**
 * The one-call sort runs on Flash by default: on the demo house it matched Pro
 * (9/9) at ~1/15 of the cost. "Careful" re-checks use GEMINI_MODEL (Pro).
 */
export const SORT_FAST_MODEL = process.env.GEMINI_SORT_MODEL || "gemini-3-flash-preview";

/**
 * Wall art for the 3D house. 3.1 Flash Image followed the 4-strip layout and
 * matched the photos; Flash Lite Image (half the price) ignored the layout in
 * testing. "Careful" uses 3 Pro Image (~2× the price).
 */
export const WALL_ART_MODEL = process.env.GEMINI_WALL_MODEL || "gemini-3.1-flash-image";
export const WALL_ART_CAREFUL_MODEL = process.env.GEMINI_WALL_CAREFUL_MODEL || "gemini-3-pro-image-preview";

export class MissingKeyError extends Error {}

function client(apiKey: string | null): GoogleGenAI {
  if (!apiKey) throw new MissingKeyError("No Gemini API key: set GEMINI_API_KEY on the server or enter your own key");
  return new GoogleGenAI({ apiKey });
}

function splitDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("Expected a base64 data URL");
  return { mimeType: m[1], data: m[2] };
}

const ROOM_GRAPH_SCHEMA = {
  type: "object",
  properties: {
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "short snake_case id, unique, e.g. kitchen, bedroom_2" },
          label: { type: "string", description: "label as printed on the plan, or a sensible name" },
          type: {
            type: "string",
            enum: ["living", "kitchen", "dining", "bedroom", "bathroom", "hallway", "entry", "office", "laundry", "closet", "garage", "outdoor", "stairs", "other"],
          },
          neighbors: {
            type: "array",
            items: { type: "string" },
            description: "ids of rooms you can walk into directly from this one (shared doorway or open plan)",
          },
          centroid: {
            type: "object",
            description: "room centre in normalized image coordinates, 0..1, origin top-left",
            properties: { x: { type: "number" }, y: { type: "number" } },
            required: ["x", "y"],
          },
          bbox: {
            type: ["object", "null"],
            description: "room's bounding box in normalized image coordinates (0..1 from top-left)",
            properties: { x0: { type: "number" }, y0: { type: "number" }, x1: { type: "number" }, y1: { type: "number" } },
            required: ["x0", "y0", "x1", "y1"],
          },
          sizeM: {
            type: ["object", "null"],
            description: "approximate width (left-right on the plan) and depth (top-bottom) in metres if dimensions are printed, else null",
            properties: { width: { type: "number" }, depth: { type: "number" } },
          },
        },
        required: ["id", "label", "type", "neighbors", "centroid", "bbox"],
      },
    },
    notes: { type: "string", description: "caveats: unreadable areas, multiple floors, uncertain doorways" },
  },
  required: ["rooms"],
};

const ROOM_GRAPH_PROMPT = `You are reading a residential floor plan image.
Identify every distinct room or space (including hallways, closets you can walk into, and open-plan zones that a buyer would think of as separate — e.g. split an open kitchen/living area into "kitchen" and "living").
For each room give: a unique snake_case id, its label, a type, the ids of rooms directly reachable from it (through a doorway or open-plan boundary — not just touching walls), and its centre point and bounding box in normalized image coordinates (0..1 from the top-left of THIS image).
If the plan prints dimensions (e.g. 12'6" x 11'), convert to metres for sizeM; otherwise null.
If there are multiple floors on the image, include all rooms and connect floors via their stairs.
Return only JSON matching the schema.`;

export async function extractRoomGraph(apiKey: string | null, floorPlanDataUrl: string): Promise<{ raw: string; parsed: unknown; usage: GeminiUsage }> {
  const res = await client(apiKey).models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ inlineData: splitDataUrl(floorPlanDataUrl) }, { text: ROOM_GRAPH_PROMPT }] }],
    config: { responseMimeType: "application/json", responseJsonSchema: ROOM_GRAPH_SCHEMA, temperature: 0.2 },
  });
  const raw = res.text ?? "";
  return { raw, parsed: JSON.parse(raw), usage: geminiUsage(GEMINI_MODEL, res.usageMetadata, process.env) };
}

/**
 * Place several photos of one (already known) room on the floor plan in one
 * call. `floorPlanDataUrl` should have the room outlined (the prompt says red).
 */
export async function placePhotos(
  apiKey: string | null,
  room: Room,
  graph: RoomGraph,
  photoDataUrls: string[],
  floorPlanDataUrl: string,
  fixed: FixedCamera[] = [],
): Promise<{ raw: string; parsed: unknown; usage: GeminiUsage }> {
  const parts = [
    { text: "FLOOR PLAN (the room is outlined in red):" },
    { inlineData: splitDataUrl(floorPlanDataUrl) },
    ...photoDataUrls.flatMap((url, i) => [{ text: `PHOTO ${i + 1}:` }, { inlineData: splitDataUrl(url) }]),
    { text: placementPrompt(room, graph, photoDataUrls.length, fixed) },
  ];
  return streamJson(apiKey, parts, PLACEMENT_SCHEMA);
}

/**
 * JSON-mode call for long multi-image prompts (30–60 s of thinking). Streaming
 * with thought summaries keeps bytes flowing, so proxies with an idle timeout
 * don't cut the call.
 */
async function streamJson(
  apiKey: string | null,
  parts: Part[],
  schema: object,
  model = GEMINI_MODEL,
): Promise<{ raw: string; parsed: unknown; usage: GeminiUsage }> {
  const stream = await client(apiKey).models.generateContentStream({
    model,
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      temperature: 0.2,
      thinkingConfig: { includeThoughts: true },
    },
  });
  let raw = "";
  let usageMetadata;
  for await (const chunk of stream) {
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) if (!part.thought && part.text) raw += part.text;
    usageMetadata = chunk.usageMetadata ?? usageMetadata;
  }
  return { raw, parsed: JSON.parse(raw), usage: geminiUsage(model, usageMetadata, process.env) };
}

/**
 * Sort a whole listing's photos into rooms in one call (see lib/sorting.ts).
 * Photos go at medium resolution (~560 tokens each instead of ~1100): plenty
 * to judge wall colour, flooring and fixtures. The plan stays at high.
 */
export async function sortPhotos(
  apiKey: string | null,
  graph: RoomGraph,
  photos: (SortPhotoInput & { dataUrl: string })[],
  floorPlanDataUrl: string | undefined,
  context: string[],
  careful = false,
): Promise<{ raw: string; parsed: unknown; usage: GeminiUsage }> {
  const parts: Part[] = [
    ...(floorPlanDataUrl
      ? [
          { text: "FLOOR PLAN:" },
          { inlineData: splitDataUrl(floorPlanDataUrl), mediaResolution: { level: PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH } },
        ]
      : []),
    ...photos.flatMap((p, i) => [
      { text: `PHOTO ${i + 1}:` },
      { inlineData: splitDataUrl(p.dataUrl), mediaResolution: { level: PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM } },
    ]),
    { text: sortPrompt(graph, photos, context) },
  ];
  return streamJson(apiKey, parts, SORT_SCHEMA, careful ? GEMINI_MODEL : SORT_FAST_MODEL);
}

/** One room's wall art (see lib/wall-art.ts): photos + a blank 4-strip template in, one image out. */
export async function generateWallArt(
  apiKey: string | null,
  room: WallArtRoom,
  photoDataUrls: string[],
  templateDataUrl: string,
  careful = false,
): Promise<{ dataUrl: string; usage: GeminiUsage; model: string }> {
  const model = careful ? WALL_ART_CAREFUL_MODEL : WALL_ART_MODEL;
  const parts: Part[] = [
    ...photoDataUrls.flatMap((url, i) => [{ text: `PHOTO ${i + 1}:` }, { inlineData: splitDataUrl(url) }]),
    { text: "TEMPLATE (4 strips, top to bottom):" },
    { inlineData: splitDataUrl(templateDataUrl) },
    { text: wallArtPrompt(room) },
  ];
  const res = await client(apiKey).models.generateContent({
    model,
    contents: [{ role: "user", parts }],
    config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: WALL_ART_ASPECT } },
  });
  const img = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!img?.inlineData?.data) {
    const why = res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason ?? "no image returned";
    throw new Error(`Gemini returned no image (${why})`);
  }
  return {
    dataUrl: `data:${img.inlineData.mimeType ?? "image/png"};base64,${img.inlineData.data}`,
    usage: geminiUsage(model, res.usageMetadata, process.env),
    model,
  };
}
