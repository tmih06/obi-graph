import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The engine is consumable both as a relative source tree and through the
    // package's public entry; both resolve to the same module instance.
    alias: {
      "@graph": fileURLToPath(new URL("./src/graph/index.ts", import.meta.url)),
      "@": src,
    },
  },
  server: {
    port: Number(process.env.PORT ?? 5190),
    strictPort: true,
  },
  fmt: {
    ignorePatterns: ["dist/**"],
  },
  lint: {
    ignorePatterns: ["dist/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
