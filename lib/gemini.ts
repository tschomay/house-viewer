import "server-only";
import { GoogleGenAI } from "@google/genai";
import type { RoomGraph } from "./types";

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";

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

export async function extractRoomGraph(apiKey: string | null, floorPlanDataUrl: string): Promise<{ raw: string; parsed: unknown }> {
  const res = await client(apiKey).models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ inlineData: splitDataUrl(floorPlanDataUrl) }, { text: ROOM_GRAPH_PROMPT }] }],
    config: { responseMimeType: "application/json", responseJsonSchema: ROOM_GRAPH_SCHEMA, temperature: 0.2 },
  });
  const raw = res.text ?? "";
  return { raw, parsed: JSON.parse(raw) };
}

const MATCH_SCHEMA = {
  type: "object",
  properties: {
    roomId: { type: ["string", "null"], description: "id from the room list, or null if you cannot tell / not an interior room photo" },
    confidence: { type: "number", description: "0..1 — how sure you are about roomId" },
    isExterior: { type: "boolean", description: "true for exterior, yard, street, aerial or community-amenity photos" },
    headingDeg: {
      type: ["number", "null"],
      description: "compass direction the camera faces ON THE FLOOR PLAN image: 0 = towards the top of the plan, 90 = right, 180 = bottom, 270 = left. null if unknown",
    },
    cameraPosition: {
      type: ["object", "null"],
      description: "approximate camera position on the floor plan image, normalized 0..1 from top-left; null if unknown",
      properties: { x: { type: "number" }, y: { type: "number" } },
    },
    reasoning: { type: "string", description: "one or two sentences: which visual cues (fixtures, windows, doorways) you used" },
  },
  required: ["roomId", "confidence", "isExterior", "headingDeg", "reasoning"],
};

export async function matchPhoto(
  apiKey: string | null,
  photoDataUrl: string,
  graph: RoomGraph,
  floorPlanDataUrl?: string,
): Promise<{ raw: string; parsed: unknown }> {
  const roomList = graph.rooms
    .map((r) => `- ${r.id}: ${r.label} (${r.type}), centre (${r.centroid.x.toFixed(2)}, ${r.centroid.y.toFixed(2)}), connects to [${r.neighbors.join(", ")}]`)
    .join("\n");
  const parts = [
    { text: "PHOTO:" },
    { inlineData: splitDataUrl(photoDataUrl) },
    ...(floorPlanDataUrl ? [{ text: "FLOOR PLAN (for orientation):" }, { inlineData: splitDataUrl(floorPlanDataUrl) }] : []),
    {
      text: `This is a real-estate listing photo of a home. Rooms on the floor plan:
${roomList}

Which room was this photo most likely taken in? Use fixtures (sinks, tubs, appliances, beds), window and door positions, and the room's shape relative to the floor plan.
Also estimate which way the camera faces on the floor plan and roughly where it stands (photographers usually shoot from a doorway or corner).
Be honest with confidence: several similar bedrooms/bathrooms should get lower confidence unless something distinguishes them.
Return only JSON matching the schema.`,
    },
  ];
  const res = await client(apiKey).models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", responseJsonSchema: MATCH_SCHEMA, temperature: 0.2 },
  });
  const raw = res.text ?? "";
  return { raw, parsed: JSON.parse(raw) };
}
