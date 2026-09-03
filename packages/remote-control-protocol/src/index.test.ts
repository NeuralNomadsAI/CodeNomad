import assert from "node:assert/strict"
import test from "node:test"
import { decodeBase64, encodeBase64 } from "./index"

test("binary relay payloads round-trip without truncation", () => {
  const input = Uint8Array.from({ length: 100_000 }, (_, index) => index % 251)
  assert.deepEqual(decodeBase64(encodeBase64(input)), input)
})
