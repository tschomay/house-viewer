// Copies the onnxruntime-web WASM runtime into public/ort so in-browser depth
// estimation doesn't depend on a third-party CDN. Runs before dev/build.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const src = join(process.cwd(), "node_modules/onnxruntime-web/dist");
const dest = join(process.cwd(), "public/ort");
mkdirSync(dest, { recursive: true });
for (const f of readdirSync(src)) {
  // Every variant: onnxruntime picks one at runtime (plain, asyncify, jsep/WebGPU, jspi)
  // depending on the device, and a missing file makes model loading hang silently.
  if (/^ort-wasm-simd-threaded(\.\w+)?\.(wasm|mjs)$/.test(f)) cpSync(join(src, f), join(dest, f));
}
console.log("copied onnxruntime-web wasm → public/ort");
