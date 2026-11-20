// Bundled plugin payloads of a release, copied from the TS server's dist (after npm run build --workspace @neuralnomads/codenomad).
//   node install/build-plugins.mjs <output folder>
import assert from "node:assert/strict"
import { cp, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

assert(process.argv[2], "usage: build-plugins.mjs <output folder>")
const out = path.resolve(process.argv[2])
const plugins = fileURLToPath(new URL("../../server/dist/plugins/", import.meta.url))
for (const feature of ["session-pruning", "automation", "missions", "memory"]) {
  await stat(path.join(plugins, feature, "plugin.mjs"))
  await cp(path.join(plugins, feature), path.join(out, feature), { recursive: true })
}
console.log(out)
