import assert from "node:assert/strict"
import { lstatSync, realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const runDirectory = fileURLToPath(new URL("./run", import.meta.url))

function resolved(p) {
  if (lstatSync(p, { throwIfNoEntry: false })) return realpathSync.native(p)
  return path.join(resolved(path.dirname(p)), path.basename(p))
}

export function privatePath(p) {
  assert(path.isAbsolute(p ?? ""), "Bench requires an absolute private path")
  const actual = resolved(path.normalize(p))
  const relative = path.relative(path.join(realpathSync.native(path.dirname(runDirectory)), "run"), actual)
  assert(!path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..", "Bench path escapes the private run directory")
  return actual
}
