import { readFileSync } from "node:fs"
import path from "node:path"
import { SourceMapConsumer } from "source-map-js"

export function byFunction(file, assets, events) {
  const coverage = JSON.parse(readFileSync(file, "utf8"))
  const calls = new Map()
  for (const script of coverage) {
    const code = readFileSync(path.join(assets, script.url), "utf8")
    const map = new SourceMapConsumer(JSON.parse(readFileSync(path.join(assets, `${script.url}.map`), "utf8")))
    const lineStarts = [0]
    for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1)
    for (const [name, offset, count] of script.fns) {
      let lo = 0, hi = lineStarts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (lineStarts[mid] <= offset) lo = mid
        else hi = mid - 1
      }
      // The V8 range can start just outside the mapping of the first token.
      const original = map.originalPositionFor({ line: lo + 1, column: offset - lineStarts[lo], bias: SourceMapConsumer.LEAST_UPPER_BOUND })
      const source = (original.source ?? script.url).replace(/^(\.\.\/)+/, "").replace(/^node_modules\//, "~/")
      const key = `${source}:${original.line ?? 0} ${original.name ?? name}`
      calls.set(key, (calls.get(key) ?? 0) + count / events)
    }
  }
  return calls
}

export function byFile(functions) {
  const files = new Map()
  for (const [key, calls] of functions) {
    const file = key.slice(0, key.indexOf(":"))
    files.set(file, (files.get(file) ?? 0) + calls)
  }
  return files
}
