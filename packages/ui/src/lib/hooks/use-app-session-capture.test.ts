import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { it } from "node:test"

const capture = readFileSync(new URL("./use-app-session-capture.ts", import.meta.url), "utf8")

it("preserves settled tabs during native shutdown", () => {
  assert.match(capture, /nativeShutdown\s*&& current\.tabs\.length === 0/)
  assert.match(capture, /\(nativeFallbackState\?\.tabs\.length \?\? 0\) > 0/)
})

it("makes native shutdown terminal for reactive captures", () => {
  assert.match(capture, /if \(nativeShutdown\) nativeShutdownGeneration = nativeShutdownGenerationRequest/)
  assert.match(capture, /if \(!enabled\(\) \|\| disposed \|\| nativeShutdownGeneration !== null\) return/)
})

it("keeps navigation flushes nonterminal", () => {
  assert.match(capture, /flush\(nativeShutdown \? payload\.generation : undefined\)/)
  assert.match(capture, /"client-state:flush-requested",[\s\S]*?, true\)/)
  assert.match(capture, /"client-state:navigation-flush-requested",[\s\S]*?, false\)/)
})

it("resumes capture only after native shutdown cancellation", () => {
  assert.match(capture, /listen<\{ generation: number \}>\("client-state:flush-cancelled"/)
  assert.match(capture, /if \(nativeShutdownGeneration !== payload\.generation\) return[\s\S]*nativeShutdownGeneration = null[\s\S]*schedule\(\)/)
})

it("waits for server storage writes during native shutdown", () => {
  assert.match(capture, /nativeShutdown \? \[storage\.flushWrites\(\)\] : \[\]/)
})
