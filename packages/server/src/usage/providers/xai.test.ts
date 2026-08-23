import assert from "node:assert/strict"
import test from "node:test"

import { parseXaiUsage } from "./xai"

function usagePayload(percent: number): Uint8Array {
  const value = Buffer.alloc(4)
  value.writeFloatLE(percent)
  return new Uint8Array([0x0d, ...value])
}

function frame(payload: Uint8Array, flags = 0): Uint8Array {
  const length = payload.length
  return new Uint8Array([flags, length >>> 24, length >>> 16, length >>> 8, length, ...payload])
}

test("parses framed and unframed xAI usage", () => {
  assert.ok(Math.abs(parseXaiUsage(usagePayload(42.5)).usedPercent - 42.5) < 0.001)
  assert.ok(Math.abs(parseXaiUsage(frame(usagePayload(75))).usedPercent - 75) < 0.001)
})

test("rejects malformed frames and nonzero gRPC trailers", () => {
  assert.throws(() => parseXaiUsage(new Uint8Array([0, 0, 0, 0, 2, 1])), /framing/)
  assert.throws(() => parseXaiUsage(frame(new TextEncoder().encode("grpc-status: 7\r\n"), 0x80)), /status 7/)
})
