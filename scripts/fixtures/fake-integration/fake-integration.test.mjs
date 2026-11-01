import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { integrationMarkerSchema, integrationRpcSchemas } from "../../../packages/server/src/opencode/integrations/contract.ts"
import { startFakeNpmRegistry } from "../fake-npm-registry.mjs"
import { assertNoSentinels, createFakeIntegrationRpc, createOfferRegistry, FAKE_INTEGRATION_SENTINELS, fakeIntegrationMarker, findSentinels,
  MAX_BINDINGS, MAX_OFFERS, OFFER_LEASE_MS, packFakeIntegration, sharedOfferRegistry, startFakeHost, writeFakeIntegrationPackage } from "./index.mjs"

const cleanups = []
after(async () => { for (const cleanup of cleanups.reverse()) await cleanup() })
async function fakeHost(options) {
  const host = await startFakeHost(options)
  cleanups.push(() => host.close())
  return host
}
async function temporary() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fake-integration-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

// An integration whose clock the test moves, with every output checked against the contract and for secrets.
function harness(options = {}) {
  let time = 1_000_000
  const events = []
  const marker = fakeIntegrationMarker()
  const registry = createOfferRegistry({ protocol: 1, now: () => time })
  const rpc = createFakeIntegrationRpc({ marker, registry, ...options })
  const disconnect = rpc.connect({ events: { emit: async (name, data) => { events.push({ name, data }) } } }, 60_000)
  cleanups.push(async () => disconnect())
  const call = async (method, input = {}, port) => {
    const output = await rpc.handlers[method](input)
    assert(integrationRpcSchemas[`${method}.output`].safeParse(output).success, `${method} answers within the contract: ${JSON.stringify(output)}`)
    if (port !== undefined) assertNoSentinels(output, { port }, method)
    return output
  }
  return { call, events, registry, advance: ms => { time += ms } }
}

describe("fake integration package", () => {
  it("writes a conforming marker, a self-contained module and the native RPC definition", async () => {
    const directory = await temporary()
    const written = await writeFakeIntegrationPackage(path.join(directory, "package"))
    const manifest = JSON.parse(await readFile(path.join(directory, "package", "package.json"), "utf8"))
    assert.equal(manifest.name, "@neuralnomads/opencode-fixture")
    assert.deepEqual(integrationMarkerSchema.parse(manifest.opencodeIntegration), written.marker)
    const entry = await readFile(path.join(directory, "package", "index.js"), "utf8")
    assert.match(entry, /from "\.\/core\.mjs"/)
    for (const method of ["status", "installHost", "hosts", "attachHost", "detachHost", "bindingRead", "advertise", "withdraw"]) assert.match(entry, new RegExp(`"${method}":\\{"input"`))
    assert.doesNotMatch(entry, /"pattern"/, "OpenCode refuses patterns in RPC definitions")
    const packed = await packFakeIntegration(directory, { id: "drift", markerMismatch: true })
    assert.equal(packed.name, "@neuralnomads/opencode-drift")
    assert.equal(packed.marker.rpc, "neuralnomads.drift")
    assert.ok(packed.tarball.length > 0)
  })

  it("reports another integration ID in marker-mismatch mode", async () => {
    const { call } = harness({ markerMismatch: true })
    assert.equal((await call("status")).integration.id, "fixture-other")
    assert.equal((await harness().call("status")).integration.id, "fixture")
  })

  it("installs only through installHost and reports the part without a live hello as unknown", async () => {
    const calls = []
    const { call } = harness({ calls })
    assert.deepEqual((await call("status")).host, { state: "absent", expectedRange: "^0.1.0", action: "install" })
    assert.deepEqual(await call("installHost", {}), { outcome: "installed" })
    assert.deepEqual(calls, ["installHost"])
    assert.deepEqual((await call("status")).host, { state: "unknown", expectedRange: "^0.1.0" })
  })
})

describe("fake offer registry", () => {
  it("reads only the exact binding, with closed authority and revisions across detach and expiry", async () => {
    const host = await fakeHost()
    const { call, advance } = harness()
    const none = await call("bindingRead", { sessionID: "ses_a" }, host.port)
    assert.equal(none.state, "none")
    await call("advertise", host.advertiseInput())
    const { offers: [offer] } = await call("hosts")
    await call("attachHost", { offerID: offer.offerID, sessionID: "ses_a" })
    const attached = await call("bindingRead", { sessionID: "ses_a" }, host.port)
    assert.deepEqual(attached.binding, { offerID: offer.offerID, label: offer.label })
    assert.equal(attached.authority.registryGeneration, none.authority.registryGeneration)
    assert(attached.authority.revision > none.authority.revision)
    assert.equal((await call("bindingRead", { sessionID: "ses_b" })).state, "none")
    for (const input of [{}, null, { sessionID: "ses_a\n" }, { sessionID: "ses_a", extra: true }]) {
      assert.deepEqual(await call("bindingRead", input), { state: "unknown" })
    }
    await call("detachHost", { sessionID: "ses_a" })
    assert((await call("bindingRead", { sessionID: "ses_a" })).authority.revision > attached.authority.revision)
    await call("attachHost", { offerID: offer.offerID, sessionID: "ses_a" })
    advance(OFFER_LEASE_MS)
    const expired = await call("bindingRead", { sessionID: "ses_a" })
    assert.equal(expired.state, "none")
    assert(expired.authority.revision > attached.authority.revision)
  })

  it("creates an offer only after a valid hello and keeps every secret out of outputs and events", async () => {
    const host = await fakeHost({ leaky: true })
    const { call, events } = harness()
    assert.deepEqual(await call("advertise", host.advertiseInput(), host.port), { outcome: "accepted" })
    const { offers } = await call("hosts", {}, host.port)
    assert.deepEqual(Object.keys(offers[0]).sort(), ["label", "offerID", "protocol"], "the leaky document and app version are dropped")
    assert.deepEqual(await call("attachHost", { offerID: offers[0].offerID, sessionID: "ses_a" }, host.port), { outcome: "attached" })
    const status = await call("status", {}, host.port)
    assert.equal(status.host.state, "ok")
    assert.deepEqual(status.connection, { state: "attached", offers: 1, attachedSessions: 1 })
    assert.deepEqual([...new Set(events.map(event => event.name))].sort(), ["hosts_changed", "status_changed"])
    for (const event of events) assert.deepEqual(event.data, {})
    assert.deepEqual(host.requests, [{ method: "hello", authorized: true }])
  })

  it("refuses announcements outside the contract without saying why", async () => {
    const host = await fakeHost()
    const { call } = harness()
    const refused = [
      host.advertiseInput({ host: "localhost" }),
      host.advertiseInput({ protocol: 2 }),
      host.advertiseInput({ label: `Scene ${FAKE_INTEGRATION_SENTINELS.token}` }),
      host.advertiseInput({ label: `Scene on ${host.port}` }),
      host.advertiseInput({ token: "f".repeat(64) }),
      host.advertiseInput({ script_handle: "another-handle" }),
      { ...host.advertiseInput(), extra: true },
      "not an object",
    ]
    for (const input of refused) assert.deepEqual(await call("advertise", input), { outcome: "refused" }, JSON.stringify(input))
    const otherProtocol = await fakeHost({ protocol: 2 })
    assert.deepEqual(await call("advertise", otherProtocol.advertiseInput({ protocol: 1, offer_key: "other" })), { outcome: "refused" })
    assert.deepEqual(await call("hosts"), { offers: [] })
  })

  it("expires an offer 15 seconds after its last renewal on the injected clock and breaks its bindings", async () => {
    const host = await fakeHost()
    const { call, advance, events } = harness()
    await call("advertise", host.advertiseInput())
    const { offers: [offer] } = await call("hosts")
    await call("attachHost", { offerID: offer.offerID, sessionID: "ses_a" })
    advance(OFFER_LEASE_MS - 1)
    assert.deepEqual(await call("advertise", host.advertiseInput()), { outcome: "renewed" })
    assert.equal(host.requests.length, 1, "a renewal sends no hello")
    advance(OFFER_LEASE_MS - 1)
    assert.equal((await call("hosts")).offers.length, 1)
    events.length = 0
    advance(1)
    assert.deepEqual(await call("hosts"), { offers: [] })
    assert.deepEqual(events.map(event => event.name), ["hosts_changed", "status_changed"])
    assert.deepEqual((await call("status")).connection, { state: "none", offers: 0, attachedSessions: 0 })
    assert.deepEqual(await call("attachHost", { offerID: offer.offerID, sessionID: "ses_a" }), { outcome: "gone" })
  })

  it("answers busy, refused, detached and none as rpc-contract.md defines", async () => {
    const first = await fakeHost(), second = await fakeHost({ token: "c".repeat(64), scriptHandle: "second" }), newer = await fakeHost({ token: "d".repeat(64), scriptHandle: "newer", hostVersion: "0.2.0" })
    const { call } = harness()
    await call("advertise", first.advertiseInput({ offer_key: "first" }))
    await call("advertise", second.advertiseInput({ offer_key: "second" }))
    await call("advertise", newer.advertiseInput({ offer_key: "newer" }))
    const offers = (await call("hosts")).offers
    const [a, b, c] = offers
    assert.equal(c.protocol, "incompatible", "a host part above ^0.1.0 is incompatible")
    assert.equal((await call("status")).host.state, "incompatible", "the least favourable live hello wins")
    assert.deepEqual(await call("attachHost", { offerID: c.offerID, sessionID: "ses_a" }), { outcome: "refused" })
    assert.deepEqual(await call("attachHost", { offerID: a.offerID, sessionID: "ses_a" }), { outcome: "attached" })
    assert.deepEqual(await call("attachHost", { offerID: a.offerID, sessionID: "ses_a" }), { outcome: "attached" })
    assert.deepEqual(await call("attachHost", { offerID: b.offerID, sessionID: "ses_a" }), { outcome: "busy" })
    assert.deepEqual(await call("detachHost", { sessionID: "ses_a" }), { outcome: "detached" })
    assert.deepEqual(await call("detachHost", { sessionID: "ses_a" }), { outcome: "none" })
  })

  it("replaces an offer with another token only after a successful hello", async () => {
    const original = await fakeHost(), replacement = await fakeHost({ token: "e".repeat(64) })
    const { call } = harness()
    await call("advertise", original.advertiseInput())
    const { offers: [offer] } = await call("hosts")
    await call("attachHost", { offerID: offer.offerID, sessionID: "ses_a" })
    assert.deepEqual(await call("advertise", original.advertiseInput({ token: "e".repeat(64) })), { outcome: "refused" }, "the original host rejects the new token")
    assert.equal((await call("hosts")).offers[0].offerID, offer.offerID)
    assert.deepEqual(await call("advertise", replacement.advertiseInput()), { outcome: "accepted" })
    const { offers: [next] } = await call("hosts")
    assert.notEqual(next.offerID, offer.offerID)
    assert.equal((await call("status")).connection.attachedSessions, 0, "the replaced offer's bindings break")
    assert.deepEqual(await call("withdraw", { offer_key: FAKE_INTEGRATION_SENTINELS.offerKey, token: "a".repeat(64) }), { outcome: "none" })
    assert.deepEqual(await call("withdraw", { offer_key: FAKE_INTEGRATION_SENTINELS.offerKey, token: "e".repeat(64) }), { outcome: "withdrawn" })
  })

  it(`holds at most ${MAX_OFFERS} offers`, async () => {
    const host = await fakeHost()
    const { call } = harness()
    for (let index = 0; index < MAX_OFFERS; index++) assert.equal((await call("advertise", host.advertiseInput({ offer_key: `k${index}` }))).outcome, "accepted")
    assert.deepEqual(await call("advertise", host.advertiseInput({ offer_key: "one-more" })), { outcome: "refused" })
  })

  it("keeps the cap and one offer per key under concurrent announcements", async () => {
    const host = await fakeHost()
    // Every hello resolves only once all announcements are in flight.
    let release
    const gate = new Promise(resolve => { release = resolve })
    const registry = createOfferRegistry({ protocol: 1, hello: async () => { await gate; return host.hello() } })
    const many = Array.from({ length: MAX_OFFERS + 4 }, (_, index) => registry.advertise(host.advertiseInput({ offer_key: `k${index}` })))
    const same = [registry.advertise(host.advertiseInput({ offer_key: "same" })), registry.advertise(host.advertiseInput({ offer_key: "same" }))]
    release()
    await Promise.all([...many, ...same])
    const { offers } = registry.hosts()
    assert.equal(offers.length, MAX_OFFERS)
    assert(integrationRpcSchemas["hosts.output"].safeParse({ offers }).success)
    const second = createOfferRegistry({ protocol: 1, hello: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return host.hello() } })
    await Promise.all([second.advertise(host.advertiseInput({ offer_key: "same" })), second.advertise(host.advertiseInput({ offer_key: "same" }))])
    assert.equal(second.hosts().offers.length, 1, "one offer per offer key")
  })

  it("refuses a hello outside host.schema.json and reports a 0.1.0 prerelease as outdated", async () => {
    const { call } = harness()
    const broken = [
      hello => { const { revision: _, ...rest } = hello; return rest },
      hello => ({ ...hello, host_version: "not-a-version" }),
      hello => ({ ...hello, app_version: "C:\\Blender" }),
      hello => ({ ...hello, document: "/home/a/scene" }),
      hello => ({ ...hello, capabilities: { ...hello.capabilities, extra: true } }),
      hello => ({ ...hello, capability_hash: "0".repeat(64) }),
    ]
    for (const [index, helloOverride] of broken.entries()) {
      const host = await fakeHost({ helloOverride })
      assert.deepEqual(await call("advertise", host.advertiseInput({ offer_key: `broken-${index}` })), { outcome: "refused" }, `hello variant ${index}`)
    }
    const prerelease = await fakeHost({ hostVersion: "0.1.0-dev.1" })
    assert.deepEqual(await call("advertise", prerelease.advertiseInput()), { outcome: "accepted" })
    assert.deepEqual((await call("status")).host, { state: "outdated", partVersion: "0.1.0-dev.1", expectedRange: "^0.1.0", appVersion: "1.0.0", action: "update" })
  })

  it("validates attachHost and detachHost IDs itself and bounds the bindings", async () => {
    const host = await fakeHost()
    const { call, registry } = harness()
    await call("advertise", host.advertiseInput())
    const { offers: [offer] } = await call("hosts")
    assert.deepEqual(await call("attachHost", { offerID: offer.offerID, sessionID: "ses.dotted" }), { outcome: "refused" })
    assert.deepEqual(await call("attachHost", { offerID: "short", sessionID: "ses_a" }), { outcome: "gone" })
    assert.deepEqual(await call("attachHost", null), { outcome: "refused" })
    assert.deepEqual(await call("detachHost", { sessionID: "s".repeat(129) }), { outcome: "none" })
    for (let index = 0; index < MAX_BINDINGS; index++) registry.attach(offer.offerID, `ses_${index}`)
    assert.deepEqual(await call("attachHost", { offerID: offer.offerID, sessionID: "ses_extra" }), { outcome: "refused" })
    assert.equal((await call("status")).connection.attachedSessions, MAX_BINDINGS)
  })

  it("shares one registry per integration across module evaluations", () => {
    const marker = fakeIntegrationMarker("shared")
    const first = sharedOfferRegistry(marker)
    assert.equal(sharedOfferRegistry(structuredClone(marker)), first)
    assert.notEqual(sharedOfferRegistry(fakeIntegrationMarker("other")), first)
  })

  it("finds every sentinel, including the port as a digit run outside offer IDs", () => {
    const port = 54_321
    assert.deepEqual(findSentinels({ a: FAKE_INTEGRATION_SENTINELS.scriptHandle, b: [`x${FAKE_INTEGRATION_SENTINELS.token}`], c: port }, { port }).sort(), ["port", "scriptHandle", "token"])
    assert.deepEqual(findSentinels({ label: "build 54321" }, { port }), ["port"])
    assert.deepEqual(findSentinels({ offerID: "offer_54321abc" }, { port }), [])
  })
})

describe("fake npm registry", () => {
  it("serves published packuments and tarballs, scoped names included, and 404 for any other name", async () => {
    const registry = await startFakeNpmRegistry()
    cleanups.push(() => registry.close())
    registry.publish("@neuralnomads/opencode-fixture", "0.1.0", Buffer.from("tarball"))
    const packument = await (await fetch(`${registry.url}/@neuralnomads%2fopencode-fixture`)).json()
    assert.equal(packument["dist-tags"].latest, "0.1.0")
    const tarball = await fetch(packument.versions["0.1.0"].dist.tarball)
    assert.equal(await tarball.text(), "tarball")
    assert.match(packument.versions["0.1.0"].dist.integrity, /^sha512-/)
    assert.equal((await fetch(`${registry.url}/@neuralnomads/opencode-unknown`)).status, 404)
    assert.equal((await fetch(`${registry.url}/%E0%A4%A`)).status, 400, "a malformed escape answers 400")
    assert.ok(registry.requested.includes("/@neuralnomads/opencode-unknown"))
  })
})
