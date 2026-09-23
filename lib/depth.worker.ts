/// <reference lib="webworker" />
// Runs Depth Anything V2 (small, ONNX) in the browser via transformers.js.
// WebGPU when available, WASM otherwise.
import { env, pipeline, type DepthEstimationPipeline } from "@huggingface/transformers";

const MODEL = "onnx-community/depth-anything-v2-small";

env.allowLocalModels = false;
// Self-hosted runtime (see scripts/copy-ort.mjs) so we don't depend on a CDN.
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: string } };
if (onnx.wasm) onnx.wasm.wasmPaths = `${self.location.origin}/ort/`;

let estimator: Promise<DepthEstimationPipeline> | null = null;

async function load(): Promise<DepthEstimationPipeline> {
  const hasGpu = "gpu" in navigator && !!(await (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
  const progress = (p: { status: string; progress?: number; file?: string }) => {
    if (p.status === "progress") self.postMessage({ type: "progress", file: p.file, progress: p.progress });
  };
  if (hasGpu) {
    try {
      return (await pipeline("depth-estimation", MODEL, { device: "webgpu", dtype: "fp16", progress_callback: progress })) as DepthEstimationPipeline;
    } catch (e) {
      console.warn("WebGPU depth failed, falling back to WASM", e);
    }
  }
  return (await pipeline("depth-estimation", MODEL, { device: "wasm", dtype: "q8", progress_callback: progress })) as DepthEstimationPipeline;
}

self.onmessage = async (e: MessageEvent<{ id: string; dataUrl: string }>) => {
  const { id, dataUrl } = e.data;
  try {
    estimator ??= load();
    const run = await estimator;
    const out = (await run(dataUrl)) as { depth: { width: number; height: number; data: Uint8Array; channels: number } };
    const { width, height, data, channels } = out.depth;
    const gray = channels === 1 ? data : data.filter((_, i) => i % channels === 0);
    self.postMessage({ type: "result", id, width, height, data: gray }, [gray.buffer]);
  } catch (err) {
    estimator = null;
    self.postMessage({ type: "error", id, error: (err as Error).message });
  }
};
