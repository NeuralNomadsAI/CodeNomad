import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { DEVICE_IDLE_EXPIRY_MS, PAIRING_TTL_MS, RemoteDeviceRegistry, deviceNameFromUserAgent, pairingFromCode } from "./devices"

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-remote-devices-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let now = Date.parse("2026-10-09T12:00:00.000Z")
  const file = path.join(directory, "remote-control-devices.json")
  return {
    file,
    open: () => new RemoteDeviceRegistry(file, () => now),
    advance: (ms: number) => { now += ms },
  }
}

test("the tunnel route is a stable random DNS label", (t) => {
  const { open } = fixture(t)
  const route = open().route()
  assert.match(route, /^codenomad-[0-9a-f]{12}$/)
  assert.equal(open().route(), route)
})

test("a pairing code is single-use and a newer code replaces it", (t) => {
  const { open } = fixture(t)
  const registry = open()
  const first = registry.createPairing()
  const second = registry.createPairing()
  assert.equal(registry.exchange(first.code, "Old link"), null)
  const paired = registry.exchange(second.code, "Phone")
  assert.ok(paired)
  assert.equal(paired.device.name, "Phone")
  assert.equal(registry.exchange(second.code, "Replay"), null)
})

test("pairing codes expire", (t) => {
  const { open, advance } = fixture(t)
  const registry = open()
  const pairing = registry.createPairing()
  advance(PAIRING_TTL_MS)
  assert.equal(registry.exchange(pairing.code, "Late"), null)
})

test("device credentials are stored hashed, survive restarts and can be revoked", (t) => {
  const { file, open } = fixture(t)
  const registry = open()
  const paired = registry.exchange(registry.createPairing().code, "Tablet")
  assert.ok(paired)
  assert.equal(fs.readFileSync(file, "utf8").includes(paired.token), false)

  const restarted = open()
  assert.equal(restarted.authenticate(paired.token)?.id, paired.device.id)
  assert.equal(restarted.authenticate("not-a-device"), null)
  assert.equal(restarted.revoke(paired.device.id), true)
  assert.equal(restarted.authenticate(paired.token), null)
  assert.equal(open().authenticate(paired.token), null)
})

test("devices expire after a period without use, and use extends it", (t) => {
  const { open, advance } = fixture(t)
  const registry = open()
  const paired = registry.exchange(registry.createPairing().code, "Laptop")
  assert.ok(paired)
  advance(DEVICE_IDLE_EXPIRY_MS - 1)
  assert.ok(registry.authenticate(paired.token))
  advance(DEVICE_IDLE_EXPIRY_MS - 1)
  assert.ok(registry.authenticate(paired.token))
  advance(DEVICE_IDLE_EXPIRY_MS)
  assert.equal(registry.authenticate(paired.token), null)
  assert.deepEqual(registry.list(), [])
})

test("an unreadable registry file starts fresh instead of failing", (t) => {
  const { file, open } = fixture(t)
  fs.writeFileSync(file, "{ not json")
  assert.match(open().route(), /^codenomad-/)
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 1)
})

test("pairing links carry the code in the fragment only", () => {
  const pairing = pairingFromCode("https://codenomad-abc.tunnel.example", { code: "secret", expiresAt: "2026-10-09T12:05:00.000Z" })
  const url = new URL(pairing.url)
  assert.equal(url.pathname, "/remote-pair")
  assert.equal(url.search, "")
  assert.equal(url.hash, "#secret")
})

test("device names summarize the browser user agent", () => {
  assert.equal(deviceNameFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"), "iPhone · Safari")
  assert.equal(deviceNameFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0"), "Windows · Edge")
  assert.equal(deviceNameFromUserAgent(undefined), "Device · Browser")
})
