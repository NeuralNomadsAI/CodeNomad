import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { registerRequestLogging } from "../request-logging"
import { IntegrationAttachments } from "../../opencode/integrations/attachments"
import { INTEGRATION_ATTACHMENT_METADATA_KEY as key } from "../../integration-types"
import { catalogEntry, catalogOf, pluginSnapshot } from "../../opencode/integrations/catalog-fixture"
import { PluginControlsError } from "../../opencode/plugin-controls"
import { NativeMutationUncertainError, type NativeMutationAuthority } from "../../opencode/native-mutation-authority"
import { registerIntegrationAttachmentRoutes } from "./integration-attachments"

const secret = "SECRET_SENTINEL_TOKEN_SCRIPT_BINDING_PORT"
const offer = { offerID: "offer_fixture", label: "Blender window", document: "Scene.blend", appVersion: "5.2.0", protocol: "ok" }
const status = () => ({ contract: 1, integration: { id: "fixture", version: "0.1.0", family: "native", spec: 0 },
  host: { state: "ok" }, connection: { state: "available", offers: 1, attachedSessions: 0 } })
const authority = { serviceGeneration: "service_private", registryGeneration: "registry_private", revision: 1 }
const binding = { state: "attached", authority, binding: { offerID: offer.offerID, label: offer.label } }

function harness(options: {
  outputs?: Record<string, unknown>
  rpc?: (method: string, input: unknown, location: unknown) => unknown | Promise<unknown>
  onRpc?: (method: string) => void
  onGet?: (count: number) => void
  timeoutMs?: number
  controlsError?: unknown
  family?: "native" | "api"
  active?: boolean
  ambiguous?: boolean
  wslDistro?: string
  hostPlatform?: NodeJS.Platform
  hostEnv?: NodeJS.ProcessEnv
  readKernelVersion?: () => Promise<string>
  onControls?: () => void | Promise<void>
  onWrite?: () => void
  catalogEmpty?: boolean
  updateError?: boolean
  guardHintRead?: boolean
} = {}) {
  const state = { current: true, owned: true, directory: "/work", workspaceID: undefined as string | undefined,
    sessionID: undefined as string | undefined, locations: {} as Record<string, string>,
    missing: false, gets: 0, metadata: { unrelated: { nested: true }, "codenomad.other": "keep" } as Record<string, any> }
  const calls: Array<{ rpcID: string; method: string; input: unknown; location: unknown }> = []
  const trace: string[] = [], writes: unknown[] = [], logs: string[] = [], catalogReads: unknown[] = []
  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        trace.push("get")
        options.onGet?.(++state.gets)
        if (state.missing) throw Object.assign(new Error(secret), { _tag: "SessionNotFoundError" })
        const metadata = structuredClone(state.metadata)
        return { id: state.sessionID ?? sessionID, location: { directory: state.locations[sessionID] ?? state.directory, ...(state.workspaceID ? { workspaceID: state.workspaceID } : {}) },
          metadata: options.guardHintRead ? new Proxy(metadata, { get(target, name) { assert.notEqual(name, key, "Q8 must never be read"); return Reflect.get(target, name) } }) : metadata }
      },
      update: async (input: { sessionID: string; metadata: Record<string, unknown> }) => {
        trace.push("update")
        if (options.updateError) throw new Error(secret)
        writes.push(input)
        // Native metadata is whole-object replacement, including deletion of omitted keys.
        state.metadata = structuredClone(input.metadata)
        options.onWrite?.()
      },
    },
    rpc: { call: async (input: { rpcID: string; method: string; input: unknown; location: unknown }) => {
      trace.push(input.method)
      calls.push(input)
      options.onRpc?.(input.method)
      const output = options.rpc ? await options.rpc(input.method, input.input, input.location) : options.outputs?.[input.method]
        ?? (input.method === "status" ? status() : input.method === "hosts" ? { offers: [offer] }
          : input.method === "attachHost" ? { outcome: "attached" } : { outcome: "detached" })
      return { output }
    } },
  }
  const snapshot = () => pluginSnapshot({
    sources: [{ target: "@neuralnomads/opencode-fixture", scope: "global", entryIndex: 0, hasOptions: false, pluginId: options.ambiguous ? "neuralnomads.other" : "neuralnomads.fixture" }],
    runtime: options.active === false ? [] : [{ key: "fixture", id: options.ambiguous ? "neuralnomads.other" : "neuralnomads.fixture", features: {},
      source: { type: "package", target: "@neuralnomads/opencode-fixture", version: "0.1.0" }, state: { status: "active" } }],
  })
  const attachments = new IntegrationAttachments({
    controls: { read: async (_id, location) => { await options.onControls?.(); if (options.controlsError) throw options.controlsError; return { ...snapshot(), location } } },
    catalog: { read: async input => { catalogReads.push(input); return { state: "fresh", catalog: options.catalogEmpty ? catalogOf() : catalogOf(catalogEntry("fixture", { family: options.family ?? "native" })) } } },
    workspaceManager: {
      getSharedServiceConnection: async () => ({ client, assertCurrent: () => { if (!state.current) throw new Error(secret) } }) as never,
      ownsLocation: async () => state.owned,
      getServiceWslDistro: () => options.wslDistro,
    },
    timeoutMs: options.timeoutMs ?? 1_000,
    now: () => 123456789,
    hostPlatform: options.hostPlatform ?? "win32",
    hostEnv: options.hostEnv,
    readKernelVersion: options.readKernelVersion,
  })
  const logger = pino({ level: "trace" }, { write: (line: string) => { logs.push(line) } })
  const app = Fastify({ logger: false })
  registerRequestLogging(app, logger)
  app.addHook("onRequest", async request => { request.log = logger })
  registerIntegrationAttachmentRoutes(app, { attachments })
  const request = async (action: "hosts" | "binding" | "attach" | "detach" | "install-host", payload?: Record<string, unknown>, query = action === "binding" ? "directory=%2Fwork&sessionID=ses_fixture" : "directory=%2Fwork", integration = "fixture") => {
    const response = await app.inject({
    method: action === "hosts" || action === "binding" ? "GET" : "POST", url: `/api/workspaces/w/integrations/${integration}/${action}?${query}`,
    ...(action === "hosts" || action === "binding" ? {} : { payload: payload ?? (action === "install-host" ? {} : action === "attach" ? { offerID: offer.offerID, sessionID: "ses_fixture" } : { sessionID: "ses_fixture" }) }),
    })
    assert.equal(logs.join("").includes(secret), false, "actual trace/debug/route logs contain no sentinel")
    assert.equal(logs.some(line => JSON.parse(line).msg === "HTTP request payload"), true, "actual trace completion was captured")
    return response
  }
  return { app, attachments, state, calls, trace, writes, logs, request, catalogReads }
}

describe("native mutation authority", () => {
  it("read-only hosts refresh full authority twice while mutation prerequisite checkpoints remain intact", async t => {
    for (const [action, expected] of [["hosts", 2], ["attach", 37], ["detach", 21], ["installHost", 13]] as const) {
      const f = harness({ outputs: { installHost: { outcome: "installed" } } }); t.after(() => f.app.close())
      let checks = 0
      const guard = { async revalidate() { checks++ }, assertCurrent() {} }
      if (action === "hosts") await f.attachments.hosts("w", "fixture", { directory: "/work" }, undefined, guard)
      else if (action === "installHost") await f.attachments.installHost("w", "fixture", { directory: "/work" }, undefined, guard)
      else if (action === "attach") await f.attachments.attach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture", offerID: offer.offerID }, undefined, guard)
      else await f.attachments.detach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture" }, undefined, guard)
      assert.equal(checks, expected, action)
    }
  })

  for (const method of ["status", "hosts"] as const) for (const change of ["target", "revoke", "connection", "ownership", "abort"] as const) {
    it(`read-only hosts refuses ${change} during ${method} without publishing offers`, async t => {
      let dirty = false, revoked = false
      const controller = new AbortController()
      const f = harness({ onRpc: called => {
        if (called !== method) return
        if (change === "target") dirty = true
        else if (change === "revoke") revoked = true
        else if (change === "connection") f.state.current = false
        else if (change === "ownership") f.state.owned = false
        else controller.abort()
      } }); t.after(() => f.app.close())
      const guard = { async revalidate() { if (dirty) throw new Error("asynchronous-only target drift") }, assertCurrent() { if (revoked) throw new Error("revoked") } }
      await assert.rejects(f.attachments.hosts("w", "fixture", { directory: "/work" }, controller.signal, guard))
      assert.equal(f.writes.length, 0); assert.ok(!f.calls.some(call => call.method === "attachHost"))
    })
  }

  it("asynchronous-only drift during the final metadata read blocks Q8; drift after Q8 remains uncertain with no replay", async t => {
    for (const stage of ["beforeQ8", "afterQ8"] as const) {
      let dirty = false
      const f = harness({ onGet: count => { if (stage === "beforeQ8" && count === 7) dirty = true },
        onWrite: () => { if (stage === "afterQ8") dirty = true } }); t.after(() => f.app.close())
      const guard = { async revalidate() { if (dirty) throw new Error("fresh target changed") }, assertCurrent() {} }
      await assert.rejects(f.attachments.attach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture", offerID: offer.offerID }, undefined, guard), NativeMutationUncertainError)
      assert.equal(f.calls.filter(call => call.method === "attachHost").length, 1)
      assert.equal(f.writes.length, stage === "beforeQ8" ? 0 : 1)
      if (stage === "afterQ8") assert.equal(f.state.metadata[key].integration, "fixture", "Authoritative read observes the already-written hint")
    }
  })

  it("an authority-bearing attach timeout remains uncertain and a late attached reply cannot write Q8", async t => {
    let enter!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const f = harness({ timeoutMs: 30, rpc: async method => {
      if (method === "attachHost") { enter(); await gate; return { outcome: "attached" } }
      return method === "status" ? status() : { offers: [offer] }
    } }); t.after(() => { release(); return f.app.close() })
    const pending = f.attachments.attach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture", offerID: offer.offerID }, undefined,
      { async revalidate() {}, assertCurrent() {} })
    const rejected = assert.rejects(pending, NativeMutationUncertainError)
    await reached; await rejected; release(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.calls.filter(call => call.method === "attachHost").length, 1); assert.equal(f.writes.length, 0)
  })

  for (const action of ["attach", "detach", "installHost"] as const) {
    for (const reason of ["expired", "session", "digest", "connection", "stale mount"]) {
      it(`${action} refuses ${reason} authority before catalog, RPC or writes`, async t => {
        const f = harness({ outputs: { installHost: { outcome: "installed" } } })
        t.after(() => f.app.close())
        let revoked: string | undefined = reason
        const guard: NativeMutationAuthority = {
          async revalidate() { this.assertCurrent() },
          assertCurrent() { if (revoked) throw new Error(`authority revoked: ${revoked}`) },
        }
        const pending = action === "installHost"
          ? f.attachments.installHost("w", "fixture", { directory: "/work" }, undefined, guard)
          : action === "attach" ? f.attachments.attach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture", offerID: offer.offerID }, undefined, guard)
            : f.attachments.detach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture" }, undefined, guard)
        await assert.rejects(pending)
        assert.deepEqual([f.catalogReads.length, f.calls.length, f.writes.length], [0, 0, 0])
        revoked = undefined
      })
    }
  }

  for (const [action, method] of [["attach", "status"], ["attach", "hosts"], ["installHost", "status"]] as const) it(`${action} revocation during ${method} read prevents mutation dispatch`, async t => {
    let entered!: () => void, release!: () => void, revoked = false
    const reading = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const f = harness({ rpc: async called => {
      if (called === method) { entered(); await gate }
      return called === "status" ? status() : called === "hosts" ? { offers: [offer] } : { outcome: action === "attach" ? "attached" : "installed" }
    } })
    t.after(() => { release(); return f.app.close() })
    const guard: NativeMutationAuthority = {
      async revalidate() { this.assertCurrent() }, assertCurrent() { if (revoked) throw new Error("revoked") },
    }
    const pending = action === "installHost" ? f.attachments.installHost("w", "fixture", { directory: "/work" }, undefined, guard)
      : f.attachments.attach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture", offerID: offer.offerID }, undefined, guard)
    await reading
    revoked = true; release()
    await assert.rejects(pending)
    assert.equal(f.calls.some(call => call.method === "attachHost" || call.method === "installHost"), false)
    assert.equal(f.writes.length, 0)
  })

  it("rechecks authority after an awaited revalidation and synchronously at final dispatch", async t => {
    for (const timing of ["awaited", "dispatch"]) await t.test(timing, async t => {
      let entered!: () => void, release!: () => void, revoked = false
      const checking = new Promise<void>(resolve => { entered = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      const f = harness({ onGet: count => { if (timing === "dispatch" && count === 5) revoked = true } })
      t.after(() => { release(); return f.app.close() })
      const guard: NativeMutationAuthority = {
        async revalidate() { this.assertCurrent(); if (timing === "awaited") { entered(); await gate } },
        assertCurrent() { if (revoked) throw new Error("revoked") },
      }
      const pending = f.attachments.attach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture", offerID: offer.offerID }, undefined, guard)
      if (timing === "awaited") {
        const reached = await Promise.race([checking.then(() => true), pending.then(() => false, () => false)])
        revoked = true; release()
        assert.equal(reached, true, "service must await authority.revalidate()")
      }
      await assert.rejects(pending)
      assert.equal(f.calls.some(call => call.method === "attachHost"), false)
      assert.equal(f.writes.length, 0)
    })
  })

  it("revokes a second operation while waiting on the actual per-session queue", async t => {
    let entered!: () => void, release!: () => void, queued!: () => void, revoked = false, controls = 0
    const dispatched = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const admitted = new Promise<void>(resolve => { queued = resolve })
    const f = harness({ onControls: () => { if (++controls === 2) queued() }, rpc: async method => {
      if (method === "attachHost") { entered(); await gate }
      return method === "status" ? status() : method === "hosts" ? { offers: [offer] } : { outcome: method === "attachHost" ? "attached" : "detached" }
    } })
    t.after(() => { release(); return f.app.close() })
    const first = f.attachments.attach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture", offerID: offer.offerID })
    await dispatched
    const guard: NativeMutationAuthority = {
      async revalidate() { this.assertCurrent() }, assertCurrent() { if (revoked) throw new Error("revoked") },
    }
    const second = f.attachments.detach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture" }, undefined, guard)
    const rejected = assert.rejects(second)
    await admitted
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.calls.some(call => call.method === "detachHost"), false, "second action is queued")
    revoked = true; release()
    await first
    await rejected
    assert.equal(f.calls.some(call => call.method === "detachHost"), false)
    assert.equal(f.writes.length, 1, "only the ordinary first operation writes")
  })

  for (const action of ["attach", "detach", "installHost"] as const) for (const cancellation of ["revoked", "aborted"]) {
    it(`${action} is uncertain when ${cancellation} after dispatch; late replies cannot writeHint or replay`, async t => {
      let entered!: () => void, release!: () => void, revoked = false
      const dispatched = new Promise<void>(resolve => { entered = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      const mutation = action === "attach" ? "attachHost" : action === "detach" ? "detachHost" : "installHost"
      const f = harness({ rpc: async method => {
        if (method === mutation) { entered(); await gate }
        return method === "status" ? status() : method === "hosts" ? { offers: [offer] }
          : { outcome: action === "attach" ? "attached" : action === "detach" ? "detached" : "installed" }
      } })
      t.after(() => { release(); return f.app.close() })
      f.state.metadata[key] = { integration: "fixture", label: "existing", attachedAt: 1 }
      const before = structuredClone(f.state.metadata), controller = new AbortController()
      const guard: NativeMutationAuthority = {
        async revalidate() { this.assertCurrent() }, assertCurrent() { if (revoked) throw new Error("revoked") },
      }
      const pending = action === "installHost"
        ? f.attachments.installHost("w", "fixture", { directory: "/work" }, controller.signal, guard)
        : action === "attach" ? f.attachments.attach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture", offerID: offer.offerID }, controller.signal, guard)
          : f.attachments.detach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture" }, controller.signal, guard)
      const rejected = assert.rejects(pending, NativeMutationUncertainError)
      await dispatched
      if (cancellation === "aborted") controller.abort()
      else { revoked = true; release() }
      try { await rejected } finally { release(); await new Promise(resolve => setImmediate(resolve)) }
      assert.equal(f.calls.filter(call => call.method === mutation).length, 1)
      assert.equal(f.writes.length, 0)
      assert.deepEqual(f.state.metadata, before)
    })
  }

  it("keeps ordinary controls and valid-authority WSL refusal unchanged despite mirrored offers", async t => {
    const ordinary = harness({ outputs: { installHost: { outcome: "installed" } } })
    t.after(() => ordinary.app.close())
    assert.deepEqual((await ordinary.request("attach")).json(), { outcome: "attached" })
    assert.deepEqual((await ordinary.request("detach")).json(), { outcome: "detached" })
    assert.deepEqual((await ordinary.request("install-host")).json(), { outcome: "installed" })
    assert.equal(ordinary.writes.length, 2)
    const guard: NativeMutationAuthority = { async revalidate() {}, assertCurrent() {} }
    for (const options of [{ wslDistro: "Ubuntu" }, { hostPlatform: "linux" as const, hostEnv: { WSL_DISTRO_NAME: "Ubuntu" } },
      { hostPlatform: "linux" as const, hostEnv: {}, readKernelVersion: async () => "Microsoft-standard-WSL2" }]) {
      const f = harness(options)
      t.after(() => f.app.close())
      await assert.rejects(f.attachments.installHost("w", "fixture", { directory: "/work" }, undefined, guard), { code: "unsupported" })
      assert.deepEqual([f.catalogReads.length, f.calls.length, f.writes.length], [0, 0, 0])
    }
  })

  it("retains whole-action uncertainty on metadata failure after binding submission", async t => {
    const guard: NativeMutationAuthority = { async revalidate() {}, assertCurrent() {} }
    for (const action of ["attach", "detach"] as const) {
      const f = harness({ updateError: true })
      t.after(() => f.app.close())
      const pending = action === "attach"
        ? f.attachments.attach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture", offerID: offer.offerID }, undefined, guard)
        : f.attachments.detach("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture" }, undefined, guard)
      await assert.rejects(pending, NativeMutationUncertainError)
      assert.equal(f.calls.filter(call => call.method === (action === "attach" ? "attachHost" : "detachHost")).length, 1)
    }
  })
})

describe("integration attachment routes (real service and schemas)", () => {
  it("AC-C12 validates the whole binding then projects only state/label, independent of Q8", async t => {
    for (const output of [binding, { state: "none", authority }, { state: "unknown" }, { state: "unknown", authority }]) {
      const f = harness({ outputs: { bindingRead: output }, guardHintRead: true })
      t.after(() => f.app.close())
      f.state.metadata[key] = { integration: "fixture", label: "stale hint", attachedAt: 1 }
      const before = structuredClone(f.state.metadata)
      const response = await f.request("binding")
      assert.equal(response.statusCode, 200)
      assert.equal(response.headers["cache-control"], "no-store")
      assert.deepEqual(response.json(), output.state === "attached" ? { state: "attached", label: offer.label } : { state: output.state })
      assert.deepEqual(f.calls, [{ rpcID: "neuralnomads.fixture", method: "bindingRead", input: { sessionID: "ses_fixture" }, location: { directory: "/work" } }])
      assert.deepEqual(f.trace, ["get", "bindingRead", "get"])
      assert.deepEqual(f.state.metadata, before)
      assert.equal(f.writes.length, 0)
      assert.equal(JSON.stringify(response.json()).includes("private"), false)
    }
  })

  it("AC-C12 closes the query before any IO, including duplicate and non-native session IDs", async t => {
    const f = harness()
    t.after(() => f.app.close())
    for (const query of ["", "directory=%2Fwork", "sessionID=ses_fixture", "directory=%2Fwork&sessionID=other",
      "directory=%2Fwork&sessionID=ses_a%0A", "directory=%2Fwork&sessionID=ses_a&sessionID=ses_b",
      "directory=%2Fwork&sessionID=ses_a&rpcID=neuralnomads.other", "directory=%2Fwork&sessionID=ses_a&method=status",
      "directory=%2Fwork&sessionID=ses_a&workspaceID=old", "directory=%2Fwork&directory=%2Fother&sessionID=ses_a"]) {
      const response = await f.request("binding", undefined, query)
      assert.equal(response.statusCode, 400, query)
      assert.equal(response.headers["cache-control"], "no-store")
    }
    assert.equal(f.calls.length, 0)
    assert.equal(f.catalogReads.length, 0)
    assert.equal(f.state.gets, 0)
    await assert.rejects(f.attachments.bindingRead("w", "fixture", { directory: "/work" }, { sessionID: "ses_a", extra: true } as never), { code: "invalid" })
  })

  it("AC-C12 never interprets missing authority, malformed/extra nested fields, unsafe labels or native failures as none", async t => {
    const outputs = [{ state: "none" }, { state: "attached", binding: binding.binding },
      { ...binding, token: secret }, { ...binding, authority: { ...authority, binding_key: secret } },
      { ...binding, binding: { ...binding.binding, script_handle: secret } },
      { ...binding, authority: { ...authority, revision: Number.MAX_SAFE_INTEGER + 1 } },
      { ...binding, authority: { ...authority, serviceGeneration: "bad\n" } },
      { ...binding, binding: { ...binding.binding, offerID: "short" } },
      ...["C:private", "~private", "/private/scene", "bad\n", "x".repeat(121)].map(label => ({ ...binding, binding: { ...binding.binding, label } })),
      { state: "unknown", authority: { ...authority, revision: -1 } }, { state: "none", authority, binding: binding.binding }]
    for (const output of outputs) {
      const f = harness({ outputs: { bindingRead: output } })
      t.after(() => f.app.close())
      assert.deepEqual((await f.request("binding")).json(), { state: "unknown" })
      assert.equal(f.writes.length, 0)
    }
    for (const type of ["rpc.unavailable", "rpc.method_not_found", "rpc.invalid_output", "other"]) {
      const f = harness({ rpc: () => { throw Object.assign(new Error(secret), { _tag: "RpcError", type, input: secret }) } })
      t.after(() => f.app.close())
      assert.deepEqual((await f.request("binding")).json(), { state: "unknown" })
    }
    for (const options of [{ active: false }, { ambiguous: true }, { family: "api" as const }, { catalogEmpty: true },
      { controlsError: new Error(secret) }]) {
      const f = harness(options)
      t.after(() => f.app.close())
      assert.deepEqual((await f.request("binding")).json(), { state: "unknown" })
      assert.equal(f.calls.length, 0)
    }
  })

  it("AC-C12 isolates two sessions/Locations and follows the same session ID only at its newly verified Location", async t => {
    const f = harness({ rpc: (_method, input) => (input as { sessionID: string }).sessionID === "ses_a" ? binding : { state: "none", authority } })
    t.after(() => f.app.close())
    f.state.locations = { ses_a: "/work", ses_b: "/other-owned" }
    assert.deepEqual((await f.request("binding", undefined, "directory=%2Fwork&sessionID=ses_a")).json(), { state: "attached", label: offer.label })
    assert.deepEqual((await f.request("binding", undefined, "directory=%2Fother-owned&sessionID=ses_b")).json(), { state: "none" })
    const count = f.calls.length
    assert.equal((await f.request("binding", undefined, "directory=%2Fwork&sessionID=ses_b")).statusCode, 403)
    assert.equal(f.calls.length, count)
    f.state.locations.ses_a = "/other-owned"
    assert.equal((await f.request("binding", undefined, "directory=%2Fwork&sessionID=ses_a")).statusCode, 403)
    assert.equal(f.calls.length, count)
    assert.deepEqual((await f.request("binding", undefined, "directory=%2Fother-owned&sessionID=ses_a")).json(), { state: "attached", label: offer.label })
    assert.deepEqual(f.calls.at(-1)?.location, { directory: "/other-owned" })
    assert.equal(f.writes.length, 0)
  })

  it("AC-C12 checks exact native identity, ownership and connection before and after the RPC", async t => {
    for (const timing of ["before", "after"]) for (const change of ["move", "missing", "id", "ownership", "connection", "workspaceID"]) {
      let f!: ReturnType<typeof harness>
      const mutate = () => {
        if (change === "move") f.state.directory = "/moved"
        if (change === "missing") f.state.missing = true
        if (change === "id") f.state.sessionID = "ses_other"
        if (change === "ownership") f.state.owned = false
        if (change === "connection") f.state.current = false
        if (change === "workspaceID") f.state.workspaceID = "retired"
      }
      f = harness({ outputs: { bindingRead: binding }, onRpc: () => { if (timing === "after") mutate() } })
      t.after(() => f.app.close())
      if (timing === "before") mutate()
      const response = await f.request("binding")
      if (change === "missing" || change === "connection") assert.deepEqual(response.json(), { state: "unknown" })
      else assert.equal(response.statusCode, 403, `${timing} ${change}`)
      assert.equal(f.calls.length, timing === "before" ? 0 : 1)
      assert.equal(f.writes.length, 0)
    }
  })

  it("AC-C12 bounds the whole read and fences a late reply without blocking a fresh read", async t => {
    let started!: () => void, release!: (value: unknown) => void, first = true
    const entered = new Promise<void>(resolve => { started = resolve })
    const f = harness({ timeoutMs: 30, rpc: () => {
      if (!first) return { state: "none", authority }
      first = false; started(); return new Promise(resolve => { release = resolve })
    } })
    t.after(() => f.app.close())
    const pending = f.request("binding")
    await entered
    assert.deepEqual((await pending).json(), { state: "unknown" })
    assert.deepEqual((await f.request("binding")).json(), { state: "none" })
    const gets = f.state.gets
    release(binding)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.state.gets, gets, "expired continuation dispatches no native get")
    assert.equal(f.writes.length, 0)
    for (const cancellation of ["abort", "timeout"]) {
      let unblock!: () => void, began!: () => void
      const blocked = new Promise<void>(resolve => { began = resolve })
      const slow = harness({ timeoutMs: 30, onControls: () => { began(); return new Promise<void>(resolve => { unblock = resolve }) } })
      t.after(() => slow.app.close())
      const controller = new AbortController()
      const result = slow.attachments.bindingRead("w", "fixture", { directory: "/work" }, { sessionID: "ses_fixture" }, controller.signal)
      await blocked
      if (cancellation === "abort") controller.abort()
      assert.deepEqual(await result, { state: "unknown" })
      unblock()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(slow.calls.length, 0)
      assert.equal(slow.state.gets, 0)
    }
  })

  it("AC-C15 validates installation output then projects only outcomes, with one fixed catalogue call and no session IO", async t => {
    for (const outcome of ["installed", "updated", "unchanged", "refused", "failed"]) {
      const f = harness({ outputs: { installHost: { outcome, detail: "Safe explanation", token: secret, script_handle: secret } } })
      t.after(() => f.app.close())
      const response = await f.request("install-host")
      assert.equal(response.statusCode, 200)
      assert.equal(response.headers["cache-control"], "no-store")
      assert.deepEqual(response.json(), { outcome })
      assert.deepEqual(f.calls.map(call => [call.rpcID, call.method, call.input, call.location]), [
        ["neuralnomads.fixture", "status", {}, { directory: "/work" }],
        ["neuralnomads.fixture", "installHost", { target: "default" }, { directory: "/work" }],
      ])
      assert.deepEqual(f.catalogReads, [{ refresh: false }], "installation never refreshes/persists the catalogue")
      assert.equal(f.state.gets, 0)
      assert.equal(f.writes.length, 0)
      assert.equal(JSON.stringify([response.body, f.logs]).includes(secret), false)
    }
  })

  it("AC-C15 refuses malformed input and known WSL before any catalogue, RPC or metadata effects", async t => {
    const invalid = harness()
    t.after(() => invalid.app.close())
    for (const body of [{ target: "default" }, { path: secret }, { sessionID: "ses_fixture" }, { rpcID: secret }, { method: "installHost" }]) {
      assert.equal((await invalid.request("install-host", body)).statusCode, 400)
    }
    assert.equal((await invalid.app.inject({ method: "POST", url: "/api/workspaces/w/integrations/fixture/install-host?directory=%2Fwork" })).statusCode, 400)
    assert.equal((await invalid.request("install-host", {}, "directory=%2Fwork&method=installHost")).statusCode, 400)
    assert.equal(invalid.calls.length, 0)
    assert.equal(invalid.catalogReads.length, 0)
    for (const options of [
      { wslDistro: "Ubuntu" },
      { hostPlatform: "linux" as const, hostEnv: { WSL_DISTRO_NAME: "Ubuntu" } },
      { hostPlatform: "linux" as const, hostEnv: { WSL_DISTRO_NAME: "" } },
      { hostPlatform: "linux" as const, hostEnv: {}, readKernelVersion: async () => "Linux version Microsoft-standard-WSL2" },
    ]) {
      const f = harness(options)
      t.after(() => f.app.close())
      // Default status would be a live compatible offer; it cannot bypass the separate WSL check.
      assert.equal((await f.request("install-host")).statusCode, 409)
      assert.equal(f.catalogReads.length, 0)
      assert.equal(f.calls.length, 0)
      assert.equal(f.writes.length, 0)
      assert.equal(f.state.gets, 0)
    }
  })

  it("AC-C15 refuses unknown, ambiguous, inactive, foreign or superseded targets before installing", async t => {
    for (const [options, expected] of [[{ catalogEmpty: true }, 404], [{ ambiguous: true }, 502], [{ active: false }, 409],
      [{ family: "api" as const }, 409], [{ outputs: { status: { ...status(), host: { state: "unsupported" } } } }, 409],
      [{ controlsError: new PluginControlsError(secret, "forbidden") }, 403]] as const) {
      const f = harness(options)
      t.after(() => f.app.close())
      assert.equal((await f.request("install-host")).statusCode, expected)
      assert.equal(f.calls.some(call => call.method === "installHost"), false)
    }
    for (const change of ["ownership", "connection"] as const) {
      let f!: ReturnType<typeof harness>
      f = harness({ onRpc: method => {
        if (method !== "status") return
        if (change === "ownership") f.state.owned = false
        else f.state.current = false
      } })
      t.after(() => f.app.close())
      assert.equal((await f.request("install-host")).statusCode, change === "ownership" ? 403 : 503)
      assert.equal(f.calls.some(call => call.method === "installHost"), false)
    }
  })

  it("AC-C15 rejects every malformed full output and sanitizes installer failures", async t => {
    for (const output of [{ outcome: secret }, { outcome: "installed", detail: 12 }, { outcome: "installed", detail: "x".repeat(301) },
      { outcome: "installed", detail: "C:private" }, { outcome: "failed", detail: "in /private/directory" }, { outcome: "installed", detail: "bad\nvalue" }]) {
      const f = harness({ outputs: { installHost: output } })
      t.after(() => f.app.close())
      const response = await f.request("install-host")
      assert.equal(response.statusCode, 502)
      assert.equal(JSON.stringify([response.body, f.logs]).includes(secret), false)
    }
    const f = harness({ rpc: method => {
      if (method === "status") return status()
      throw Object.assign(new Error(secret), { cause: new Error(secret), input: secret })
    } })
    t.after(() => f.app.close())
    assert.equal((await f.request("install-host")).statusCode, 503)
    assert.equal(f.calls.filter(call => call.method === "installHost").length, 1, "never replay installation")
  })

  it("AC-C15 fences cancellation and timeout while authorization is still pending", async t => {
    for (const cancellation of ["abort", "timeout"]) {
      let release!: () => void, started!: () => void
      const entered = new Promise<void>(resolve => { started = resolve })
      const f = harness({ timeoutMs: 30, onControls: () => { started(); return new Promise<void>(resolve => { release = resolve }) } })
      t.after(() => f.app.close())
      const controller = new AbortController()
      const result = f.attachments.installHost("w", "fixture", { directory: "/work" }, controller.signal)
      await entered
      if (cancellation === "abort") controller.abort()
      await assert.rejects(result, { code: "unavailable" })
      release()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(f.calls.length, 0)
      assert.equal(f.writes.length, 0)
    }
  })

  it("projects opaque offers, calls only the catalog RPC, and strips unknown secret fields", async t => {
    const f = harness({ outputs: { hosts: { offers: [{ ...offer, port: secret, token: secret, script_handle: secret, binding_key: secret, offer_key: secret }], token: secret } } })
    t.after(() => f.app.close())
    const response = await f.request("hosts")
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["cache-control"], "no-store")
    assert.deepEqual(response.json(), { offers: [offer] })
    assert.deepEqual(f.calls.map(call => [call.rpcID, call.method, call.input, call.location]), [
      ["neuralnomads.fixture", "status", {}, { directory: "/work" }], ["neuralnomads.fixture", "hosts", {}, { directory: "/work" }],
    ])
    assert.equal(JSON.stringify([response.body, f.logs]).includes(secret), false)
  })

  it("attaches the exact session, writes Q8 from a fresh metadata read, and detach removes it", async t => {
    let f!: ReturnType<typeof harness>
    f = harness({ onRpc: method => { if (method === "attachHost") f.state.metadata["late.other"] = { preserve: true } } })
    t.after(() => f.app.close())
    assert.deepEqual((await f.request("attach")).json(), { outcome: "attached" })
    assert.deepEqual(f.state.metadata, { unrelated: { nested: true }, "codenomad.other": "keep", "late.other": { preserve: true },
      [key]: { integration: "fixture", label: offer.label, attachedAt: 123456789 } })
    for (const method of ["status", "hosts", "attachHost", "update"]) {
      const index = f.trace.indexOf(method)
      assert.equal(f.trace[index - 1], "get", `fresh session before ${method}`)
      assert.equal(f.trace[index + 1], "get", `fresh session after ${method}`)
    }
    assert.deepEqual((await f.request("detach")).json(), { outcome: "detached" })
    assert.equal(key in f.state.metadata, false)
    assert.deepEqual(f.state.metadata["late.other"], { preserve: true })
    assert.equal(f.writes.length, 2)
  })

  it("uses the offer label for reattach matching and treats metadata as a hint, never live authority", async t => {
    const { document: _, ...withoutDocument } = offer
    const f = harness({ outputs: { hosts: { offers: [withoutDocument] } } })
    t.after(() => f.app.close())
    f.state.metadata[key] = { integration: "fixture", label: "stale", attachedAt: 1 }
    assert.deepEqual((await f.request("attach")).json(), { outcome: "attached" })
    assert.equal(f.state.metadata[key].label, offer.label)
    assert.equal(f.calls.some(call => call.method === "attachHost"), true)
  })

  it("keeps busy/gone/refused outcomes and never writes metadata for an unsuccessful attachment", async t => {
    for (const outcome of ["busy", "gone", "refused"]) {
      const f = harness({ outputs: { attachHost: { outcome, token: secret } } })
      t.after(() => f.app.close())
      const response = await f.request("attach")
      assert.deepEqual(response.json(), { outcome })
      assert.equal(f.writes.length, 0)
      assert.equal(JSON.stringify([response.body, f.logs]).includes(secret), false)
    }
    for (const offers of [[], [{ ...offer, protocol: "incompatible" }]]) {
      const f = harness({ outputs: { hosts: { offers } } })
      t.after(() => f.app.close())
      assert.equal((await f.request("attach")).statusCode, 200)
      assert.equal(f.calls.some(call => call.method === "attachHost"), false)
      assert.equal(f.writes.length, 0)
    }
  })

  it("clears Q8 on a native none result too", async t => {
    const f = harness({ outputs: { detachHost: { outcome: "none" } } })
    t.after(() => f.app.close())
    f.state.metadata[key] = { integration: "fixture", label: "Scene.blend", attachedAt: 1 }
    assert.deepEqual((await f.request("detach")).json(), { outcome: "none" })
    assert.equal(key in f.state.metadata, false)
  })

  it("rejects strict input violations before RPC or metadata IO", async t => {
    const f = harness()
    t.after(() => f.app.close())
    for (const query of ["", "directory=%2Fwork&rpcID=neuralnomads.other", "directory=%2Fwork&method=advertise", "directory=%2Fwork&workspaceID=foreign", "directory=%00bad"]) {
      assert.equal((await f.request("hosts", undefined, query)).statusCode, 400)
    }
    for (const payload of [{ offerID: "short", sessionID: "ses_fixture" }, { offerID: offer.offerID, sessionID: "../foreign" },
      { offerID: offer.offerID, sessionID: secret },
      { offerID: offer.offerID, sessionID: "ses_fixture", token: secret }, { offerID: offer.offerID }, {}]) {
      assert.equal((await f.request("attach", payload)).statusCode, 400)
    }
    assert.equal((await f.request("detach", { sessionID: "ses_fixture", offerID: offer.offerID })).statusCode, 400)
    assert.equal((await f.request("detach", { sessionID: secret })).statusCode, 400)
    assert.equal(f.state.gets, 0)
    assert.equal(f.calls.length, 0)
    assert.equal(f.writes.length, 0)
  })

  it("refuses missing/foreign sessions, including another owned worktree and retired workspace identity", async t => {
    for (const change of ["missing", "directory", "workspaceID"] as const) {
      const f = harness()
      t.after(() => f.app.close())
      if (change === "missing") f.state.missing = true
      if (change === "directory") f.state.directory = "/other-owned-worktree"
      if (change === "workspaceID") f.state.workspaceID = "retired"
      for (const action of ["attach", "detach"] as const) {
        assert.equal((await f.request(action)).statusCode, change === "missing" ? 404 : 403)
      }
      assert.equal(f.calls.length, 0)
      assert.equal(f.writes.length, 0)
    }
    const f = harness({ controlsError: new PluginControlsError(secret, "forbidden") })
    t.after(() => f.app.close())
    assert.equal((await f.request("hosts")).statusCode, 403)
    assert.equal(JSON.stringify(f.logs).includes(secret), false)
  })

  it("rechecks native session, workspace ownership and the pinned connection after every RPC", async t => {
    for (const method of ["status", "hosts", "attachHost", "detachHost"]) {
      for (const change of ["move", "delete", "ownership", "connection"]) {
        let f!: ReturnType<typeof harness>
        f = harness({ onRpc: called => {
          if (called !== method) return
          if (change === "move") f.state.directory = "/moved"
          if (change === "delete") f.state.missing = true
          if (change === "ownership") f.state.owned = false
          if (change === "connection") f.state.current = false
        } })
        t.after(() => f.app.close())
        assert.equal((await f.request(method === "detachHost" ? "detach" : "attach")).statusCode,
          change === "delete" ? 404 : change === "connection" ? 503 : 403, `${method} ${change}`)
        assert.equal(f.writes.length, 0)
      }
    }
  })

  it("refuses all malformed outputs and path-like display strings without leaking their values", async t => {
    const outputs = [
      { hosts: { offers: [{ ...offer, document: "C:secret" }] } },
      { hosts: { offers: [{ ...offer, label: "~private" }] } },
      { hosts: { offers: [{ ...offer, document: "/private/scene" }] } },
      { hosts: { offers: [{ ...offer, appVersion: "\\private" }] } },
      { hosts: { offers: [{ ...offer, offerID: "short" }] } },
      { hosts: { offers: [{ ...offer, document: "x".repeat(121) }] } },
      { hosts: { offers: [{ ...offer, label: "control\n" }] } },
      { attachHost: { outcome: secret } },
      { status: { ...status(), integration: { ...status().integration, id: "another" } } },
      { status: { ...status(), host: { state: "ok", appVersion: "~private" } } },
    ]
    for (const output of outputs) {
      const f = harness({ outputs: output })
      t.after(() => f.app.close())
      const response = await f.request("attach")
      assert.equal(response.statusCode, 502, JSON.stringify(output))
      assert.equal(f.writes.length, 0)
      assert.equal(JSON.stringify([response.body, f.logs]).includes(secret), false)
    }
    const f = harness({ outputs: { detachHost: { outcome: secret } } })
    t.after(() => f.app.close())
    assert.equal((await f.request("detach")).statusCode, 502)
    assert.equal(f.writes.length, 0)
  })

  it("sanitizes RPC failures, detects capability errors and bounds unresponsive clients", async t => {
    for (const [type, expected] of [["rpc.unavailable", 409], ["rpc.method_not_found", 409], ["rpc.invalid_output", 502], ["other", 503]] as const) {
      const f = harness({ rpc: () => { throw Object.assign(new Error(secret), { _tag: "RpcError", type, input: secret }) } })
      t.after(() => f.app.close())
      const response = await f.request("hosts")
      assert.equal(response.statusCode, expected)
      assert.equal(JSON.stringify([response.body, f.logs]).includes(secret), false)
    }
    const f = harness({ rpc: () => new Promise(() => {}), timeoutMs: 20 })
    t.after(() => f.app.close())
    assert.equal((await f.request("attach")).statusCode, 503)
    assert.equal(f.writes.length, 0)
  })

  it("blocks unknown, inactive, non-native and unsupported hosts without attachment IO", async t => {
    for (const [options, code] of [[{ catalogEmpty: true }, 404], [{ active: false }, 409], [{ family: "api" as const }, 409],
      [{ outputs: { status: { ...status(), host: { state: "unsupported" } } } }, 409]] as const) {
      const f = harness(options)
      t.after(() => f.app.close())
      assert.equal((await f.request("attach")).statusCode, code)
      assert.equal(f.calls.some(call => call.method === "attachHost"), false)
      assert.equal(f.writes.length, 0)
    }
  })

  it("reports a metadata write failure without replaying attachment or exposing the native error", async t => {
    const f = harness({ updateError: true })
    t.after(() => f.app.close())
    const response = await f.request("attach")
    assert.equal(response.statusCode, 503)
    assert.equal(f.calls.filter(call => call.method === "attachHost").length, 1)
    assert.equal(key in f.state.metadata, false)
    assert.equal(JSON.stringify([response.body, f.logs]).includes(secret), false)
  })

  it("releases timed-out session actions and fences a late RPC before metadata dispatch", async t => {
    let started!: () => void, release!: (value: unknown) => void
    const dispatched = new Promise<void>(resolve => { started = resolve })
    const f = harness({ timeoutMs: 30, rpc: method => {
      if (method === "status") return status()
      if (method === "hosts") return { offers: [offer] }
      if (method === "attachHost") { started(); return new Promise(resolve => { release = resolve }) }
      return { outcome: "none" }
    } })
    t.after(() => f.app.close())
    const first = f.request("attach")
    await dispatched
    assert.equal((await first).statusCode, 503)
    assert.equal((await f.request("detach")).statusCode, 200)
    release({ outcome: "attached" })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.writes.length, 1, "only the later detach wrote metadata")
    assert.equal(key in f.state.metadata, false)
    assert.equal(f.logs.join("").includes(secret), false, "late completion logs contain no sentinel")
  })
})
