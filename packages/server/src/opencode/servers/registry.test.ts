import assert from "node:assert/strict"
import test from "node:test"
import { ConfigYamlSchema, OpenCodeServerProfileSchema, OpenCodeServersSchema } from "../../config/schema"
import { OpenCodeServerRegistry, parseProjectExecutionBinding, summarizeOpenCodeServers } from "./registry"
import { initialServerCapabilities, SERVER_CAPABILITY_NAMES } from "./capabilities"
import { SERVER_CONNECTION_LIMITS } from "./types"
import { normalizeExplicitOrigin } from "./endpoint"

const explicit = { kind: "explicit", id: "target-A", label: "Isolated", origin: "https://example.test" } as const

test("legacy metadata defaults to local without writing; missing bindings remain repairable and paths opaque", () => {
  const registry = new OpenCodeServerRegistry(() => undefined, () => assert.fail("implicit migration must not persist"))
  assert.deepEqual(registry.list(), [{ id: "local-shared", kind: "local-shared" }])
  assert.deepEqual(parseProjectExecutionBinding({ directory: "/Workspace/../MixedCase" }),
    { serverId: "local-shared", directory: "/Workspace/../MixedCase" })
  const binding = parseProjectExecutionBinding({ serverId: "missing-server", directory: "c:\\MixedCase\\app" })
  assert.equal(binding.directory, "c:\\MixedCase\\app")
  assert.equal(registry.get(binding.serverId), undefined)
  assert.equal(ConfigYamlSchema.safeParse({}).success, true)
  assert.throws(() => new OpenCodeServerRegistry(() => null, () => {}).list())
})

test("registry rejects duplicate IDs, invalid shapes, embedded credentials and non-root/insecure origins before writing", () => {
  let stored: unknown
  let writes = 0
  const registry = new OpenCodeServerRegistry(() => stored, value => { stored = value; writes++ })
  registry.replace([explicit])
  assert.equal(registry.get("target-A")?.kind, "explicit")
  assert.equal(registry.list()[0]?.kind, "local-shared")
  for (const value of [null, {}, [explicit, explicit], [{ ...explicit, id: "local-shared" }],
    [{ ...explicit, kind: "local-shared" }], [{ ...explicit, password: "sentinel" }],
    [{ ...explicit, credentialMode: "file" }], [{ ...explicit, id: "../bad" }],
    ...["http://example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test?secret=x",
      "https://example.test/#secret", "file:///root", "invalid"].map(origin => [{ ...explicit, origin }]),
  ]) assert.throws(() => registry.replace(value))
  assert.equal(writes, 1)
  assert.equal(OpenCodeServersSchema.safeParse([{ ...explicit, origin: "http://127.0.0.1:4096" }]).success, true)
  assert.equal(OpenCodeServersSchema.safeParse([{ ...explicit, origin: "http://[::1]:4096" }]).success, true)
  assert.throws(() => parseProjectExecutionBinding({ serverId: null, directory: "/app" }))
  assert.throws(() => parseProjectExecutionBinding({ directory: "bad\0path" }))
})

test("development metadata discards credential modes/references while preserving server identity", () => {
  for (const credentialMode of ["keychain", "memory"]) {
    const legacy = { ...explicit, credentialMode, credentialRef: "private-reference" }
    assert.deepEqual(OpenCodeServerProfileSchema.parse(legacy), explicit)
    const registry = new OpenCodeServerRegistry(() => [legacy], () => assert.fail("read must not persist"))
    assert.deepEqual(registry.get(explicit.id), explicit)
  }
})

test("admitted normalized origins round-trip through the registry including mapped loopback", () => {
  const mapped = normalizeExplicitOrigin("http://[::ffff:127.0.0.1]:1234")
  assert.equal(mapped, "http://[::ffff:7f00:1]:1234")
  assert.equal(OpenCodeServerProfileSchema.safeParse({ kind: "explicit", id: "mapped", label: "Mapped", origin: mapped }).success, true)
  let stored: unknown
  const registry = new OpenCodeServerRegistry(() => stored, value => { stored = value })
  for (const value of ["http://[::ffff:127.0.0.1]:1234", "http://[::ffff:7f02:304]:1234", "http://[::1]:1234", "http://127.2.3.4:1234", "http://localhost:1234", "https://[::ffff:192.168.1.1]:1234"]) {
    const origin = normalizeExplicitOrigin(value)
    registry.replace([{ ...explicit, origin }])
    const profile = registry.get(explicit.id)
    assert.equal(profile?.kind === "explicit" && profile.origin, origin)
  }
  for (const origin of ["http://[::ffff:c0a8:101]:1234", "http://[::ffff:a9fe:a9fe]:1234", "http://[::ffff:0:0]:1234", "http://remote.example", "https://[::ffff:a9fe:a9fe]:1234", "https://[fe80::1]:1234", "http://[::ffff:127.0.0.1]:1234"]) {
    assert.throws(() => registry.replace([{ ...explicit, origin }]), origin)
  }
})

test("public summaries whitelist fields and skip malformed origins without exposing private references", () => {
  const summary = summarizeOpenCodeServers([{ ...explicit, password: "sentinel", nested: { token: "sentinel" } },
    { ...explicit, id: "bad", origin: "https://user:sentinel@example.test" }, explicit])
  assert.equal(summary.length, 2)
  assert.deepEqual(summary[1], { kind: "explicit", id: explicit.id, label: explicit.label, origin: explicit.origin,
    hasCredentials: false, needsCredentials: true })
  assert.doesNotMatch(JSON.stringify(summary), /sentinel|private-reference|credentialRef|password|nested/)
  assert.deepEqual(summarizeOpenCodeServers({ secret: "sentinel" }), [{ id: "local-shared", kind: "local-shared" }])
})

test("closed E1 capabilities distinguish unverified chat, live-only recovery and deferred integrations", () => {
  const capabilities = initialServerCapabilities(explicit, 7)
  assert.equal(capabilities.serverId, explicit.id)
  assert.equal(capabilities.generation, 7)
  assert.deepEqual(Object.keys(capabilities.features), [...SERVER_CAPABILITY_NAMES])
  assert.equal(capabilities.features.chat.state, "unknown")
  assert.equal(capabilities.features.pendingRecovery.state, "limited")
  assert.equal(capabilities.features.pendingRecovery.reason.code, "liveOnly")
  for (const name of ["files", "git", "worktrees", "missions", "automation", "terminal", "historyEnrichment"] as const) {
    assert.equal(capabilities.features[name].state, "unavailable")
    assert.equal(capabilities.features[name].reason.code, "deferred")
  }
  assert.equal(capabilities.features.sessionEnvironment.reason.code, "localOnly")
  assert.equal(initialServerCapabilities({ kind: "local-shared", id: "local-shared" }, 1).features.chat.state, "unknown")
  assert.equal(SERVER_CONNECTION_LIMITS.explicitActiveTargets, 4)
  assert.equal(SERVER_CONNECTION_LIMITS.reservedLocalTargets, 1)
  assert.equal(SERVER_CONNECTION_LIMITS.administrativeProbes, 1)
  assert.equal(SERVER_CONNECTION_LIMITS.probeTimeoutMs, 5_000)
  assert.equal(SERVER_CONNECTION_LIMITS.probeMaxBytes, 8 * 1024 * 1024)
  assert.equal(SERVER_CONNECTION_LIMITS.secondaryBrowserReads, 2)
  assert.equal(SERVER_CONNECTION_LIMITS.eventJobs, 2_048)
  assert.equal(SERVER_CONNECTION_LIMITS.eventBytes, 32 * 1024 * 1024)
  assert.equal(SERVER_CONNECTION_LIMITS.eventJobTimeoutMs, 60_000)
  assert.equal(SERVER_CONNECTION_LIMITS.reservedLocalEventJobs, 256)
  assert.equal(SERVER_CONNECTION_LIMITS.reservedLocalEventBytes, 4 * 1024 * 1024)
})
