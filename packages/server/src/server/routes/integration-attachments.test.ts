import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { registerRequestLogging } from "../request-logging"
import { IntegrationAttachments } from "../../opencode/integrations/attachments"
import { INTEGRATION_ATTACHMENT_METADATA_KEY as key } from "../../integration-types"
import { catalogEntry, catalogOf, pluginSnapshot } from "../../opencode/integrations/catalog-fixture"
import { PluginControlsError } from "../../opencode/plugin-controls"
import { registerIntegrationAttachmentRoutes } from "./integration-attachments"

const secret = "SECRET_SENTINEL_TOKEN_SCRIPT_BINDING_PORT"
const offer = { offerID: "offer_fixture", label: "Blender window", document: "Scene.blend", appVersion: "5.2.0", protocol: "ok" }
const status = () => ({ contract: 1, integration: { id: "fixture", version: "0.1.0", family: "native", spec: 0 },
  host: { state: "ok" }, connection: { state: "available", offers: 1, attachedSessions: 0 } })

function harness(options: {
  outputs?: Record<string, unknown>
  rpc?: (method: string) => unknown | Promise<unknown>
  onRpc?: (method: string) => void
  onGet?: (count: number) => void
  timeoutMs?: number
  controlsError?: unknown
  family?: "native" | "api"
  active?: boolean
  catalogEmpty?: boolean
  updateError?: boolean
} = {}) {
  const state = { current: true, owned: true, directory: "/work", workspaceID: undefined as string | undefined,
    missing: false, gets: 0, metadata: { unrelated: { nested: true }, "codenomad.other": "keep" } as Record<string, any> }
  const calls: Array<{ rpcID: string; method: string; input: unknown; location: unknown }> = []
  const trace: string[] = [], writes: unknown[] = [], logs: string[] = []
  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        trace.push("get")
        options.onGet?.(++state.gets)
        if (state.missing) throw Object.assign(new Error(secret), { _tag: "SessionNotFoundError" })
        return { id: sessionID, location: { directory: state.directory, ...(state.workspaceID ? { workspaceID: state.workspaceID } : {}) }, metadata: structuredClone(state.metadata) }
      },
      update: async (input: { sessionID: string; metadata: Record<string, unknown> }) => {
        trace.push("update")
        if (options.updateError) throw new Error(secret)
        writes.push(input)
        // Native metadata is whole-object replacement, including deletion of omitted keys.
        state.metadata = structuredClone(input.metadata)
      },
    },
    rpc: { call: async (input: { rpcID: string; method: string; input: unknown; location: unknown }) => {
      trace.push(input.method)
      calls.push(input)
      options.onRpc?.(input.method)
      const output = options.rpc ? await options.rpc(input.method) : options.outputs?.[input.method]
        ?? (input.method === "status" ? status() : input.method === "hosts" ? { offers: [offer] }
          : input.method === "attachHost" ? { outcome: "attached" } : { outcome: "detached" })
      return { output }
    } },
  }
  const snapshot = () => pluginSnapshot({
    sources: [{ target: "@neuralnomads/opencode-fixture", scope: "global", entryIndex: 0, hasOptions: false, pluginId: "neuralnomads.fixture" }],
    runtime: options.active === false ? [] : [{ key: "fixture", id: "neuralnomads.fixture", features: {},
      source: { type: "package", target: "@neuralnomads/opencode-fixture", version: "0.1.0" }, state: { status: "active" } }],
  })
  const attachments = new IntegrationAttachments({
    controls: { read: async () => { if (options.controlsError) throw options.controlsError; return snapshot() } },
    catalog: { read: async () => ({ state: "fresh", catalog: options.catalogEmpty ? catalogOf() : catalogOf(catalogEntry("fixture", { family: options.family ?? "native" })) }) },
    workspaceManager: {
      getSharedServiceConnection: async () => ({ client, assertCurrent: () => { if (!state.current) throw new Error(secret) } }) as never,
      ownsLocation: async () => state.owned,
    },
    timeoutMs: options.timeoutMs ?? 1_000,
    now: () => 123456789,
  })
  const logger = pino({ level: "trace" }, { write: (line: string) => { logs.push(line) } })
  const app = Fastify({ logger: false })
  registerRequestLogging(app, logger)
  app.addHook("onRequest", async request => { request.log = logger })
  registerIntegrationAttachmentRoutes(app, { attachments })
  const request = async (action: "hosts" | "attach" | "detach", payload?: Record<string, unknown>, query = "directory=%2Fwork", integration = "fixture") => {
    const response = await app.inject({
    method: action === "hosts" ? "GET" : "POST", url: `/api/workspaces/w/integrations/${integration}/${action}?${query}`,
    ...(action === "hosts" ? {} : { payload: payload ?? (action === "attach" ? { offerID: offer.offerID, sessionID: "ses_fixture" } : { sessionID: "ses_fixture" }) }),
    })
    assert.equal(logs.join("").includes(secret), false, "actual trace/debug/route logs contain no sentinel")
    assert.equal(logs.some(line => JSON.parse(line).msg === "HTTP request payload"), true, "actual trace completion was captured")
    return response
  }
  return { app, attachments, state, calls, trace, writes, logs, request }
}

describe("integration attachment routes (real service and schemas)", () => {
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
