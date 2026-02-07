import fs from "fs"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { VitePWA } from "vite-plugin-pwa"
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
    {
      name: "prepare-pwa-source-icon",
      apply: "build",
      buildStart() {
        // vite-pwa-assets requires the source image inside root/public/
        const source = resolve(__dirname, "src/images/CodeNomad-Icon.png")
        const publicDir = resolve(__dirname, "src/renderer/public")
        const dest = resolve(publicDir, "logo.png")
        fs.mkdirSync(publicDir, { recursive: true })
        fs.copyFileSync(source, dest)
      },
    },
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      pwaAssets: {
        preset: "minimal-2023",
        image: "public/logo.png",
      },
      manifest: {
        name: "CodeNomad",
        short_name: "CodeNomad",
        id: "/",
        start_url: "/",
        display: "standalone",
        display_override: ["window-controls-overlay", "standalone"],
        background_color: "#1a1a1a",
        theme_color: "#1a1a1a",
      },
      workbox: {
        // Preserve server-side auth redirects (e.g., /login) instead of serving cached index.html.
        navigateFallback: null,
        // Only cache static UI assets; never cache API traffic.
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) => {
              if (url.pathname.startsWith("/api/")) return false
              return ["script", "style", "image", "font"].includes(request.destination)
            },
            handler: "CacheFirst",
            options: {
              cacheName: "asset-cache",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
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
