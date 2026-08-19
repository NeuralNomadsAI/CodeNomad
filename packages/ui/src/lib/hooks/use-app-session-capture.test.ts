import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { it } from "node:test"

const capture = readFileSync(new URL("./use-app-session-capture.ts", import.meta.url), "utf8")

it("preserves settled tabs during native shutdown", () => {
  assert.match(capture, /nativeShutdown\s*&& current\.tabs\.length === 0/)
  assert.match(capture, /\(nativeFallbackState\?\.tabs\.length \?\? 0\) > 0/)
})

it("makes native shutdown terminal for reactive captures", () => {
  assert.match(capture, /if \(nativeShutdown\) nativeShutdownStarted = true/)
  assert.match(capture, /if \(!enabled\(\) \|\| disposed \|\| nativeShutdownStarted\) return/)
})

it("keeps navigation flushes nonterminal", () => {
  assert.match(capture, /flush\(nativeShutdown\)/)
  assert.match(capture, /"client-state:flush-requested",[\s\S]*?, true\)/)
  assert.match(capture, /"client-state:navigation-flush-requested",[\s\S]*?, false\)/)
})
