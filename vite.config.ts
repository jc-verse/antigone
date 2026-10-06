import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";

declare module "@remix-run/server-runtime" {
  interface Future {
    v3_singleFetch: true;
  }
}
export default defineConfig({
  resolve: {
    alias: {
      "./runpod_bootstrap.py": `${import.meta.dirname}/app/runpod_bootstrap.py?raw`,
    },
  },
  ssr: { external: ["bun:sqlite"] },
  plugins: [remix({ future: { v3_singleFetch: true } })],
});
