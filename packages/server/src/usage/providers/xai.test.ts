import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { xaiProviders, parseXaiUsage } from "./xai"

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

test("skips an API-key xAI alias for valid Grok OAuth", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-xai-alias-"))
  const authFile = path.join(directory, "auth.json")
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousFetch = globalThis.fetch
  fs.writeFileSync(authFile, JSON.stringify({
    xai: { type: "api", key: "api-key" },
    grok: { type: "oauth", access: "grok-access", expires: Date.now() + 3_600_000 },
  }))
  process.env.OPENCODE_AUTH_FILE = authFile
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer grok-access")
    const bytes = usagePayload(25)
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  }

  try {
    const usage = await xaiProviders[0].fetchQuota()
    assert.equal(usage.ok, true)
    assert.ok(Math.abs((usage.usage?.windows.billing_cycle.usedPercent ?? 0) - 25) < 0.001)
  } finally {
    globalThis.fetch = previousFetch
    if (previousAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previousAuthFile
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("does not refresh or mutate expired xAI credentials", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-xai-expired-"))
  const authFile = path.join(directory, "auth.json")
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousFetch = globalThis.fetch
  fs.writeFileSync(authFile, JSON.stringify({ xai: { type: "oauth", access: "expired", refresh: "owner-refresh", expires: 1 } }))
  const before = fs.readFileSync(authFile, "utf8")
  process.env.OPENCODE_AUTH_FILE = authFile
  globalThis.fetch = async () => { throw new Error("expired credentials must not make requests") }

  try {
    const usage = await xaiProviders[0].fetchQuota()
    assert.equal(usage.ok, false)
    assert.match(usage.error ?? "", /Reconnect it in OpenCode/)
    assert.equal(fs.readFileSync(authFile, "utf8"), before)
  } finally {
    globalThis.fetch = previousFetch
    if (previousAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previousAuthFile
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
