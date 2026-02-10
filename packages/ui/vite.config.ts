import fs from "fs"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { VitePWA } from "vite-plugin-pwa"
import { resolve } from "path"

const uiPackageJson = JSON.parse(fs.readFileSync(resolve(__dirname, "package.json"), "utf-8")) as { version?: string }
const uiVersion = uiPackageJson.version ?? "0.0.0"

function copyMonacoPublicAssets(opts: { warn: (message: string) => void }) {
  const publicDir = resolve(__dirname, "src/renderer/public")
  const destRoot = resolve(publicDir, "monaco/vs")

  const candidates = [
    resolve(__dirname, "../../node_modules/monaco-editor/min/vs"),
    resolve(__dirname, "node_modules/monaco-editor/min/vs"),
  ]
  const sourceRoot = candidates.find((p) => fs.existsSync(resolve(p, "loader.js")))
  if (!sourceRoot) {
    opts.warn("Monaco source directory not found; skipping copy")
    return
  }

  fs.mkdirSync(destRoot, { recursive: true })

  const copyRecursive = (src: string, dest: string) => {
    const stat = fs.statSync(src)
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true })
      for (const entry of fs.readdirSync(src)) {
        copyRecursive(resolve(src, entry), resolve(dest, entry))
      }
      return
    }
    fs.copyFileSync(src, dest)
  }

  // Keep the working tree clean; these assets are generated.
  try {
    fs.rmSync(destRoot, { recursive: true, force: true })
  } catch {
    // ignore
  }
  fs.mkdirSync(destRoot, { recursive: true })

  // Copy core Monaco runtime.
  for (const dir of ["base", "editor", "platform"] as const) {
    const src = resolve(sourceRoot, dir)
    if (fs.existsSync(src)) {
      copyRecursive(src, resolve(destRoot, dir))
    }
  }

  // loader.js is required.
  copyRecursive(resolve(sourceRoot, "loader.js"), resolve(destRoot, "loader.js"))

  // Copy baseline rich language packages + workers.
  for (const lang of ["typescript", "html", "json", "css"] as const) {
    const src = resolve(sourceRoot, "language", lang)
    if (fs.existsSync(src)) {
      copyRecursive(src, resolve(destRoot, "language", lang))
    }
  }

  // Copy baseline basic tokenizers.
  for (const lang of ["python", "markdown", "cpp", "kotlin"] as const) {
    const src = resolve(sourceRoot, "basic-languages", lang)
    if (fs.existsSync(src)) {
      copyRecursive(src, resolve(destRoot, "basic-languages", lang))
    }
  }

  // Copy monaco.contribution.js entrypoints (needed by some loads).
  const monacoContribution = resolve(sourceRoot, "basic-languages", "monaco.contribution.js")
  if (fs.existsSync(monacoContribution)) {
    copyRecursive(monacoContribution, resolve(destRoot, "basic-languages", "monaco.contribution.js"))
  }
  const underscoreContribution = resolve(sourceRoot, "basic-languages", "_.contribution.js")
  if (fs.existsSync(underscoreContribution)) {
    copyRecursive(underscoreContribution, resolve(destRoot, "basic-languages", "_.contribution.js"))
  }
}

export default defineConfig({
  root: "./src/renderer",
  plugins: [
    solid(),
    {
      name: "prepare-monaco-public-assets",
      // Ensure Monaco's AMD assets exist in `root/public` for both dev server and builds.
      // These files are gitignored and generated on demand.
      configureServer(server) {
        copyMonacoPublicAssets({ warn: (msg) => server.config.logger.warn(msg) })
      },
      buildStart() {
        copyMonacoPublicAssets({ warn: (msg) => this.warn(msg) })
      },
    },
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
         // Only precache static assets (avoid caching HTML documents / routes).
         globPatterns: ["**/*.{js,css,png,jpg,jpeg,svg,webp,ico,woff,woff2,ttf,eot,json,webmanifest}"],
         // Monaco assets can be large; cache them at runtime instead.
         globIgnores: [
           "**/*.html",
           "**/assets/*worker-*.js",
           "**/assets/editor.api-*.js",
           "**/monaco/vs/**/*",
         ],
         // Only cache static UI assets; never cache API traffic.
         runtimeCaching: [
           {
            urlPattern: ({ url, request }) => {
              if (url.pathname.startsWith("/api/")) return false
              if (request.destination === "document") return false
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
