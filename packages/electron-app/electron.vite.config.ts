import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import solid from "vite-plugin-solid"
import { resolve } from "path"
import fs from "fs"

const uiRoot = resolve(__dirname, "../ui")
const uiSrc = resolve(uiRoot, "src")
const uiRendererRoot = resolve(uiRoot, "src/renderer")
const uiRendererEntry = resolve(uiRendererRoot, "index.html")
const uiRendererLoadingEntry = resolve(uiRendererRoot, "loading.html")

function copyMonacoPublicAssets(opts: { warn: (message: string) => void }) {
  const publicDir = resolve(uiRendererRoot, "public")
  const destRoot = resolve(publicDir, "monaco/vs")

  const candidates = [
    // Workspace root hoisted deps.
    resolve(__dirname, "../../node_modules/monaco-editor/min/vs"),
    // UI package local deps.
    resolve(uiRoot, "node_modules/monaco-editor/min/vs"),
  ]
  const sourceRoot = candidates.find((p) => fs.existsSync(resolve(p, "loader.js")))
  if (!sourceRoot) {
    opts.warn("Monaco source directory not found; skipping copy")
    return
  }

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

function prepareMonacoPublicAssets() {
  return {
    name: "prepare-monaco-public-assets",
    configureServer(server: any) {
      copyMonacoPublicAssets({ warn: (msg) => server.config.logger.warn(msg) })
    },
    buildStart(this: any) {
      copyMonacoPublicAssets({ warn: (msg) => this.warn(msg) })
    },
  }
}

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
    plugins: [solid(), prepareMonacoPublicAssets()],
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
      minify: false,
      cssMinify: false,
      sourcemap: true,
      outDir: resolve(__dirname, "dist/renderer"),
      rollupOptions: {
        input: {
          main: uiRendererEntry,
          loading: uiRendererLoadingEntry,
        },
        output: {
          compact: false,
          minifyInternalExports: false,
        },
      },
    },
  },
})
