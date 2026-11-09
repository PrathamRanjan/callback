import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Built into ../dist/client and served by the Express app (src/web/api.ts webApp()).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "../dist/client", emptyOutDir: true, assetsDir: "assets", sourcemap: false, chunkSizeWarningLimit: 600 },
  server: { port: 5199, proxy: { "/api": "http://localhost:3510", "/customers": "http://localhost:3510", "/calls": { target: "http://localhost:3510", bypass: (req) => (req.method === "GET" ? req.url : undefined) } } },
});
