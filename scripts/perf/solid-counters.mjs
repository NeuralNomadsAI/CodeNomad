import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"

const files = {
  "dist/solid.js": ["updateComputation", "createComputation", "cleanNode", "writeSignal"],
  "store/dist/store.js": ["setProperty"],
}

export function solidCounters(functions, solidDir) {
  const result = {}
  for (const [file, names] of Object.entries(files)) {
    const source = readFileSync(path.join(solidDir, file), "utf8").split("\n")
    for (const name of names) {
      const line = source.findIndex(text => text.startsWith(`function ${name}(`)) + 1
      assert(line, `Unknown Solid counter ${name}`)
      const prefix = `~/solid-js/${file}:${line} `
      let calls
      for (const [key, count] of functions) if (key.startsWith(prefix)) calls = (calls ?? 0) + count
      assert(Number.isFinite(calls), `Missing coverage for Solid counter ${name}`)
      result[`solid.${name}`] = calls
    }
  }
  return result
}
