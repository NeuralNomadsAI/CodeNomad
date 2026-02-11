import fs from "fs"
import { resolve } from "path"

/**
 * Copy Monaco's AMD `min/vs` assets into the UI renderer public folder.
 *
 * Monaco is loaded at runtime via `/monaco/vs/loader.js`. These assets are gitignored
 * and generated on demand in dev/build so the repo stays clean.
 *
 * @param {object} params
 * @param {string} params.uiRendererRoot Absolute path to `packages/ui/src/renderer`.
 * @param {(message: string) => void} [params.warn] Warning logger.
 * @param {string[]} [params.sourceRoots] Optional override list of `.../monaco-editor/min/vs` roots.
 */
export function copyMonacoPublicAssets(params) {
  const uiRendererRoot = params?.uiRendererRoot
  if (!uiRendererRoot) {
    throw new Error("copyMonacoPublicAssets: uiRendererRoot is required")
  }

  const warn = params?.warn ?? ((message) => console.warn(message))
  const publicDir = resolve(uiRendererRoot, "public")
  const destRoot = resolve(publicDir, "monaco/vs")

  const candidates =
    params?.sourceRoots?.length > 0
      ? params.sourceRoots
      : [
          // Workspace root hoisted deps.
          resolve(process.cwd(), "node_modules/monaco-editor/min/vs"),
          // UI package local deps (covers non-hoisted installs).
          resolve(process.cwd(), "packages/ui/node_modules/monaco-editor/min/vs"),
        ]

  const sourceRoot = candidates.find((p) => fs.existsSync(resolve(p, "loader.js")))
  if (!sourceRoot) {
    warn("Monaco source directory not found; skipping copy")
    return
  }

  const copyRecursive = (src, dest) => {
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
  for (const dir of ["base", "editor", "platform"]) {
    const src = resolve(sourceRoot, dir)
    if (fs.existsSync(src)) {
      copyRecursive(src, resolve(destRoot, dir))
    }
  }

  // loader.js is required.
  copyRecursive(resolve(sourceRoot, "loader.js"), resolve(destRoot, "loader.js"))

  // Copy baseline rich language packages + workers.
  for (const lang of ["typescript", "html", "json", "css"]) {
    const src = resolve(sourceRoot, "language", lang)
    if (fs.existsSync(src)) {
      copyRecursive(src, resolve(destRoot, "language", lang))
    }
  }

  // Copy baseline basic tokenizers.
  for (const lang of ["python", "markdown", "cpp", "kotlin"]) {
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
