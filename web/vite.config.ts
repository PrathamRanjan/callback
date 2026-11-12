import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";

/**
 * Hands-free (spec A1): MediaPipe's WebAssembly runtime is served from Callback's own server, under a versioned
 * path, so the browser fetches no code from a CDN. Loaded only when someone turns hands-free on.
 */
function mediapipeRuntime() {
  const dir = fileURLToPath(new URL("./node_modules/@mediapipe/tasks-vision", import.meta.url));
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { version: string };
  const from = `${dir}/wasm`;
  return {
    name: "callback-mediapipe-runtime",
    closeBundle() {
      const to = fileURLToPath(new URL(`../dist/client/mediapipe/${pkg.version}`, import.meta.url));
      if (!existsSync(from)) throw new Error("@mediapipe/tasks-vision/wasm is missing: run npm ci in web/");
      mkdirSync(to, { recursive: true });
      for (const f of ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"]) cpSync(`${from}/${f}`, `${to}/${f}`);
    },
  };
}

// Built into ../dist/client and served by the Express app (src/web/api.ts webApp()).
export default defineConfig({
  plugins: [react(), tailwindcss(), mediapipeRuntime()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "../dist/client", emptyOutDir: true, assetsDir: "assets", sourcemap: false, chunkSizeWarningLimit: 600 },
  server: { port: 5199, proxy: { "/api": "http://localhost:3510", "/customers": "http://localhost:3510", "/calls": { target: "http://localhost:3510", bypass: (req) => (req.method === "GET" ? req.url : undefined) } } },
});
