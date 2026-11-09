import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { createSignal } from "solid-js"
import { RemoteServerBrowseManager } from "../../server/src/codenomad-servers/browse-manager"
import { startFakeCodeNomad } from "../../server/src/codenomad-servers/test-support/fake-codenomad"
import { registerBackendRelayRoutes } from "../../server/src/server/routes/backend-relay"
import { CODENOMAD_API_CONTRACT } from "../../server/src/meta-contract"
import { RELAY_AUTHORITY_HEADER as HEADER, RELAY_AUTHORITY_QUERY as QUERY, RELAY_BOOTSTRAP } from "../../server/src/codenomad-servers/relay-authority"
import { createRemoteBackendClient } from "../src/lib/backend-client"
import { backendEvents } from "../src/lib/backend-events"
import { createBackendRegistry } from "../src/stores/backend-registry"
import { createInstance, instances } from "../src/stores/instances"
import { preferences } from "../src/stores/preferences"

for (const mode of ["retarget-auth", "retarget-anonymous", "remove-recreate", "same-target-recreate", "tls"] as const) {
  test(`immutable relay destination: ${mode}`, { timeout: 20_000 }, async t => {
    const anonymous = mode === "retarget-anonymous"
    const a = await startFakeCodeNomad({ anonymous }), b = await startFakeCodeNomad({ anonymous })
    const counters = { A: { create: 0, cancel: 0, release: 0, close: 0 }, B: { create: 0, cancel: 0, release: 0, close: 0 } }
    for (const [name, remote] of [["A", a], ["B", b]] as const) {
      remote.state.handlers.set("/api/meta", (_q, r) => {
        r.setHeader("content-type", "application/json")
        r.setHeader(HEADER, "forged-upstream")
        r.end(JSON.stringify({ apiContract: CODENOMAD_API_CONTRACT, serverId: `server-${name}`, [HEADER]: "forged-body" }))
      })
      remote.state.handlers.set("/workspaces/w/instance/api/session/s/prompt", (q, r) => {
        assert.equal(q.headers[HEADER], undefined)
        assert.equal(new URL(q.url!, remote.origin).searchParams.has(QUERY), false)
        q.resume(); q.on("end", () => { r.setHeader("content-type", "application/json"); r.end("{}") })
      })
      for (const [route, kind] of [["/api/workspaces", "create"], ["/api/workspaces/creation/cancel", "cancel"],
        ["/api/workspaces/w/creation/release", "release"], ["/api/workspaces/w", "close"]] as const) {
        remote.state.handlers.set(route, (q, r) => {
          assert.equal(q.headers[HEADER], undefined)
          assert.equal(new URL(q.url!, remote.origin).searchParams.has(QUERY), false)
          if (q.method === "GET") { r.setHeader("content-type", "application/json"); r.end("[]"); return }
          counters[name][kind]++
          let body = ""
          q.on("data", chunk => { body += chunk })
          q.on("end", () => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify(kind === "create" ? { id: "w", requestId: JSON.parse(body).requestId, path: "/same", status: "ready" } : {})) })
        })
      }
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-authority-"))
    const initial = { id: "saved", name: "A", baseUrl: a.origin, skipTlsVerify: false, createdAt: "", updatedAt: "" }
    const [profiles, setProfiles] = createSignal([initial])
    const manager = new RemoteServerBrowseManager({ getOwner: () => ({ remoteServers: profiles() }), configYamlPathForAuthority: () => path.join(directory, "config.yaml") })
    const app = Fastify()
    let origin = ""
    registerBackendRelayRoutes(app, { manager, getSelfOrigins: () => new Set([origin]) })
    origin = await app.listen({ host: "127.0.0.1", port: 0 })
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin } } })
    const seen: string[] = [], streams: string[] = []
    const fetcher: typeof fetch = (input, init) => {
      seen.push(new Headers(init?.headers).get(HEADER) ?? "absent")
      return fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin } })
    }
    const events = backendEvents
    const previousFlag = preferences().multiBackend
    preferences().multiBackend = true
    const make = (id: string) => createRemoteBackendClient(id, { bindRelayAuthority: true, fetcher,
      eventSource: url => { streams.push(url); return { close() {}, addEventListener() {}, onopen: null, onerror: null } as unknown as EventSource } })
    const registry = createBackendRegistry({ enabled: () => true, profiles, events, createClient: make,
      loadWorkspaces: async (client, signal) => { const response = await client.fetch(client.url("/api/workspaces"), { signal }); assert.equal(response.status, 200) },
    })
    t.after(async () => {
      registry.dispose(); manager.close(); app.server.closeAllConnections(); await app.close(); await a.close(); await b.close()
      preferences().multiBackend = previousFlag
      fs.rmSync(directory, { recursive: true })
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
      else Reflect.deleteProperty(globalThis, "window")
    })
    // Missing proof in an opted-in candidate fails before even the local HTTP dispatch.
    const unadmitted = make("saved"), beforeMissing = seen.length
    await assert.rejects(unadmitted.api.cancelWorkspaceCreation("r"))
    assert.equal(seen.length, beforeMissing)
    if (!anonymous) await manager.connect("saved", { username: "codenomad", password: "remote-password" })
    const old = await registry.ensure("saved")
    assert.ok(old)
    const proof = new URL(old.url("/api/workspaces")).searchParams.get(QUERY)!
    assert.match(proof, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(new URL(streams[0]).searchParams.get(QUERY), proof)
    assert(seen.includes(RELAY_BOOTSTRAP))
    const signal = events.signal("saved")!
    await old.sdk.createClient("saved~w", "/workspaces/w/instance").session.prompt({ sessionID: "s", text: "fixture" })
    assert.equal(a.state.requests.at(-1)!.path, "/workspaces/w/instance/api/session/s/prompt")
    assert.equal(seen.at(-1), proof, "generated SDK URL keeps its base and uses bound fetch")
    const operations = [() => old.api.cancelWorkspaceCreation("r"), () => old.api.releaseWorkspaceCreation("saved~w", "r"), () => old.api.deleteWorkspace("saved~w")]
    assert.equal((await old.api.createWorkspace({ path: "/same", requestId: "r" })).id, "w")
    for (const operation of operations) await operation()
    assert.deepEqual(counters.A, { create: 1, cancel: 1, release: 1, close: 1 })
    setProfiles([{ ...initial, name: "renamed" }]); manager.reconcile()
    assert.equal(await registry.ensure("saved"), old)
    assert.equal(events.signal("saved"), signal)
    assert.equal(new URL(old.url("/api/workspaces")).searchParams.get(QUERY), proof)
    for (const operation of operations) await operation()
    assert.deepEqual(counters.A, { create: 1, cancel: 2, release: 2, close: 2 })
    const beforeForged = a.state.requests.length + b.state.requests.length
    for (const forged of ["", "forged-stale-A", "x".repeat(43), RELAY_BOOTSTRAP]) {
      const response = await fetch(`${origin}/api/backends/saved/api/workspaces/w`, { method: "DELETE", headers: { origin, [HEADER]: forged } })
      assert.equal(response.status, 502)
    }
    assert.equal(a.state.requests.length + b.state.requests.length, beforeForged)
    // Hold a real store creation at its commit gate while the relay authority is replaced.
    let commit!: () => void, postReturned!: () => void
    const gate = new Promise<void>(resolve => { commit = resolve })
    const posted = new Promise<void>(resolve => { postReturned = resolve })
    const create = old.api.createWorkspace
    old.api.createWorkspace = async (...args) => { const response = await create(...args); postReturned(); return response }
    let callbacks = 0
    const creating = createInstance("/same", undefined, { backend: old, signal: new AbortController().signal,
      waitForCreateCommit: () => gate, onBeforeCreateCommit: () => { callbacks++ }, onCreateCommit: () => { callbacks++ } })
    const revokedCreation = assert.rejects(creating)
    await posted
    if (mode.includes("recreate")) { setProfiles([]); manager.reconcile(); assert.equal(signal.aborted, true) }
    const beforeQueuedClose = structuredClone(counters)
    const queuedClose = assert.rejects(Promise.resolve().then(operations[2]))
    setProfiles([{ ...initial, baseUrl: mode === "same-target-recreate" || mode === "tls" ? a.origin : b.origin, skipTlsVerify: mode === "tls" }]); manager.reconcile()
    assert.equal(signal.aborted, true)
    await queuedClose
    assert.deepEqual(counters, beforeQueuedClose)
    if (!anonymous) await manager.connect("saved", { username: "codenomad", password: "remote-password" })
    const replacement = await registry.ensure("saved")
    assert.ok(replacement); assert.notEqual(replacement, old)
    assert.notEqual(new URL(replacement.url("/api/workspaces")).searchParams.get(QUERY), proof)
    commit()
    await revokedCreation
    assert.equal(callbacks, 0)
    assert.equal(instances().has("saved~w"), false)
    assert.deepEqual(counters, beforeQueuedClose, "revoked store cleanup never dispatches to either upstream")
    assert.equal((await replacement.api.createWorkspace({ path: "/same", requestId: "r" })).id, "w")
    const beforeLate = structuredClone(counters), requestsBeforeLate = a.state.requests.length + b.state.requests.length
    await assert.rejects(old.fetch(old.url("/api/workspaces/w"), { method: "DELETE", signal }))
    // The four original red cases, plus TLS: exact methods without attachment cancellation.
    for (const operation of operations) await assert.rejects(operation())
    for (const operation of operations) await assert.rejects(operation(), "retry retains the original proof")
    assert.deepEqual(counters, beforeLate, "revoked client MUST NOT mutate replacement generation")
    assert.equal(a.state.requests.length + b.state.requests.length, requestsBeforeLate)
    await replacement.api.cancelWorkspaceCreation("r")
    const destination = mode === "same-target-recreate" || mode === "tls" ? "A" : "B"
    assert.equal(counters[destination].cancel, beforeLate[destination].cancel + 1)
    // Reconnect confirms the same proof and cannot rewrite the old client.
    const revalidation = await replacement.fetch(replacement.url("/api/meta"), { cache: "no-store" })
    assert.equal(revalidation.status, 200)
    assert.equal(revalidation.headers.get(HEADER), new URL(replacement.url("/api/workspaces")).searchParams.get(QUERY))
    assert.equal(old.admitRelayAuthority!(revalidation.headers.get(HEADER)), false)
    const currentSignal = events.signal("saved")!
    const detached = new Promise<void>(resolve => currentSignal.addEventListener("abort", () => resolve(), { once: true }))
    const remote = destination === "A" ? a : b
    remote.state.handlers.set("/api/meta", (_q, r) => {
      r.setHeader("content-type", "application/json")
      r.end(JSON.stringify({ apiContract: CODENOMAD_API_CONTRACT, serverId: "observed-replacement" }))
    })
    replacement.events.restart()
    await detached
    assert.equal(registry.state("saved"), "refused", "observed identity replacement revokes registry admission")
    assert.equal(new URL(replacement.url("/api/workspaces")).searchParams.get(QUERY), revalidation.headers.get(HEADER))
  })
}
