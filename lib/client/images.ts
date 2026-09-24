import { apiFetch } from "./access";
import type { ImageKind, ImageSource, ListingImage } from "../types";

const MAX_EDGE = 1600;

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not decode image`));
    img.src = src;
  });
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.86): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", quality),
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Downscale to ≤1600px JPEG (keeps API payloads small) and hash for caching. */
export async function toListingImage(
  blob: Blob,
  kind: ImageKind,
  source: ImageSource,
  meta: { originalUrl?: string; label?: string } = {},
): Promise<ListingImage> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff"; // floor plans are often transparent PNGs
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const jpeg = await canvasToJpeg(canvas);
    return {
      id: await sha256Hex(await jpeg.arrayBuffer()),
      kind,
      source,
      dataUrl: await blobToDataUrl(jpeg),
      width: canvas.width,
      height: canvas.height,
      ...meta,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Fetch an imported (remote) image through our proxy, since listing CDNs rarely allow CORS. */
export async function importRemoteImage(url: string, kind: ImageKind, label?: string): Promise<ListingImage> {
  const res = await apiFetch(`/api/proxy-image?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return toListingImage(await res.blob(), kind, "import", { originalUrl: url, label });
}

/** Read a grayscale image (e.g. a depth PNG) into a single-channel byte array. */
export async function readGray(dataUrl: string, maxEdge = Infinity): Promise<{ width: number; height: number; data: Uint8Array }> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, width, height);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
  return { width, height, data };
}

/** Single-channel bytes → grayscale PNG data URL. */
export function grayToDataUrl(width: number, height: number, data: ArrayLike<number>): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const v = data[i];
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Re-encode an image at ≤ maxEdge px, optionally with a red rectangle drawn on
 * it (normalized coords): used to point Gemini at one room on the floor plan.
 */
export async function redrawImage(
  dataUrl: string,
  maxEdge: number,
  outline?: { x0: number; y0: number; x1: number; y1: number } | null,
): Promise<string> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (outline) {
    ctx.strokeStyle = "#e11";
    ctx.lineWidth = Math.max(3, canvas.width / 250);
    ctx.strokeRect(outline.x0 * canvas.width, outline.y0 * canvas.height, (outline.x1 - outline.x0) * canvas.width, (outline.y1 - outline.y0) * canvas.height);
  }
  return blobToDataUrl(await canvasToJpeg(canvas));
}
