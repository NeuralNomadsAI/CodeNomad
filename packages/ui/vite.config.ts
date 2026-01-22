import fs from "fs"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { resolve } from "path"

const uiPackageJson = JSON.parse(fs.readFileSync(resolve(__dirname, "package.json"), "utf-8")) as { version?: string }
const uiVersion = uiPackageJson.version ?? "0.0.0"

export default defineConfig({
  root: "./src/renderer",
  plugins: [
    solid(),
    {
      name: "emit-ui-version",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "ui-version.json",
          source: JSON.stringify({ uiVersion }, null, 2),
        })
      },
    },
  ],
  css: {
    postcss: "./postcss.config.js",
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    exclude: ["lucide-solid"],
  },
  ssr: {
    noExternal: ["lucide-solid"],
  },
  server: {
    port: 3000,
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "./src/renderer/index.html"),
        loading: resolve(__dirname, "./src/renderer/loading.html"),
      },
    },
  },
})
