import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import solid from "vite-plugin-solid"
import { resolve } from "path"

const uiRoot = resolve(__dirname, "../ui")
const uiSrc = resolve(uiRoot, "src")
const uiRendererRoot = resolve(uiRoot, "src/renderer")
const uiRendererEntry = resolve(uiRendererRoot, "index.html")

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/main",
      lib: {
        entry: resolve(__dirname, "electron/main/main.ts"),
      },
      rollupOptions: {
        external: ["electron"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/preload",
      lib: {
        entry: resolve(__dirname, "electron/preload/index.cjs"),
        formats: ["cjs"],
        fileName: () => "index.js",
      },
      rollupOptions: {
        external: ["electron"],
        output: {
          entryFileNames: "index.js",
        },
      },
    },
  },
  renderer: {
    root: uiRendererRoot,
    plugins: [solid()],
    css: {
      postcss: resolve(uiRoot, "postcss.config.js"),
    },
    resolve: {
      alias: {
        "@": uiSrc,
      },
    },
    server: {
      port: 3000,
    },
    build: {
      outDir: resolve(__dirname, "dist/renderer"),
      rollupOptions: {
        input: uiRendererEntry,
      },
    },
  },
})
