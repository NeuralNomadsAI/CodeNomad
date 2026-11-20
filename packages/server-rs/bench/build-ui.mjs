// Builds packages/ui into out/ui, the Solid UI the `solid` mode serves through the TS server.
import path from "node:path"
import { build } from "vite"
import { out, repo } from "./fixtures.mjs"

const ui = path.join(repo, "packages/ui")
process.chdir(ui)
await build({
  configFile: path.join(ui, "vite.config.ts"),
  logLevel: "warn",
  build: { outDir: path.join(out, "ui"), emptyOutDir: true, sourcemap: false },
})
console.log(path.join(out, "ui"))
