import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const src = fileURLToPath(new URL("./src", import.meta.url));

/**
 * GitHub Pages serves a project site from `/<repo>/`, so asset URLs need that
 * prefix. Set `BASE_PATH` for a different mount (`/` for a user site or a
 * custom domain) instead of editing the config.
 */
const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [react()],
  resolve: {
    // The engine is consumable both as a relative source tree and through the
    // package's public entry; both resolve to the same module instance.
    alias: {
      "@graph": fileURLToPath(new URL("./src/graph/index.ts", import.meta.url)),
      "@": src,
    },
  },
  build: {
    // The demo is a separate artifact from the publishable library in dist/.
    outDir: "demo-dist",
    // Split the taxonomy payload from the engine so the canvas can paint a
    // frame before the graph data finishes downloading.
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [{ name: "animal-data", test: /src\/demo\/animal-data\.ts/ }],
        },
      },
    },
  },
  server: {
    port: Number(process.env.PORT ?? 5190),
    strictPort: true,
  },
  fmt: {
    // Generated taxonomy: the formatter would expand the positional payload
    // back into 500 KB of pretty-printed objects.
    ignorePatterns: ["dist/**", "demo-dist/**", "src/demo/animal-data.ts"],
  },
  lint: {
    ignorePatterns: ["dist/**", "demo-dist/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
