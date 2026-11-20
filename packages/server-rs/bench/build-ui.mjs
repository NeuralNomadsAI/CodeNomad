// Builds packages/ui into out/ui with ui-capabilities.patch (panels follow the backend's declared
// capabilities), applied to copies that Vite loads in place of the originals: the sources stay untouched.
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { build } from "vite"
import { out, repo } from "./fixtures.mjs"

const patch = path.join(import.meta.dirname, "ui-capabilities.patch")
const copies = path.join(out, "ui-patched")
rmSync(copies, { recursive: true, force: true })
const files = [...readFileSync(patch, "utf8").matchAll(/^\+\+\+ b\/(\S+)$/gm)].map(m => m[1])
for (const file of files) if (existsSync(path.join(repo, file))) {
  mkdirSync(path.dirname(path.join(copies, file)), { recursive: true })
  cpSync(path.join(repo, file), path.join(copies, file))
}
execFileSync("git", ["apply", `--directory=${path.relative(repo, copies).replaceAll("\\", "/")}`, patch], { cwd: repo, stdio: "inherit", windowsHide: true })
const patched = new Map(files.map(file => [path.join(repo, file), path.join(copies, file)]))
const ui = path.join(repo, "packages/ui")
process.chdir(ui)
await build({
  configFile: path.join(ui, "vite.config.ts"),
  logLevel: "warn",
  build: { outDir: path.join(out, "ui"), emptyOutDir: true, sourcemap: false },
  plugins: [{
    name: "bench-ui-capabilities",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith(".")) return
      const base = path.resolve(path.dirname(importer.split("?")[0]), source)
      for (const ext of ["", ".ts", ".tsx"]) if (patched.has(base + ext) && !existsSync(base + ext)) return (base + ext).replaceAll("\\", "/")
    },
    load(id) {
      const file = patched.get(path.resolve(id.split("?")[0]))
      if (file) return readFileSync(file, "utf8")
    },
  }],
})
console.log(path.join(out, "ui"))
