import assert from "node:assert/strict"
import { once } from "node:events"
import { MessageChannel } from "node:worker_threads"
import vm from "node:vm"
import test from "node:test"
import { panelExtensionDocument } from "./frame-document"

// Runs the actual injected bridge with a native MessagePort; browser tests cover its Solid host.
async function bridge(permissions: string[], apiVersion: 1 | 2 | 3 | 4 = 4) {
  let initialize: ((event: unknown) => void) | undefined
  const window: any = { addEventListener: (_: string, listener: typeof initialize) => { initialize = listener }, removeEventListener() {} }
  const parent = {}
  const html = panelExtensionDocument("", "one-use", apiVersion, permissions)
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    window, parent, document: { activeElement: null }, HTMLElement: class {}, setTimeout, clearTimeout,
  })
  const channel = new MessageChannel()
  const ready = once(channel.port1, "message")
  initialize!({ source: parent, data: { type: "codenomad:init" }, ports: [channel.port2] })
  assert.deepEqual((await ready)[0], { type: "ready", handshake: "one-use" })
  const api = window.codenomad
  const initialized = new Promise<void>(resolve => api.onContext(() => resolve()))
  channel.port1.postMessage({ type: "context", context: { sessionId: "own-session" } })
  await initialized
  const close = () => { channel.port1.close(); channel.port2.close() }
  return { api, port: channel.port1, close }
}

test("API 4 bundles is frozen and permission-scoped; APIs 1–3 stay exact", async () => {
  for (const [version, permissions, objects] of [
    [1, ["bundles.read"], []], [2, ["bundles.read"], ["assets"]], [3, ["bundles.read"], ["workItems"]],
    [4, ["panel.preferences"], ["preferences"]], [4, ["bundles.manage"], []], [4, ["bundles.read"], ["bundles"]],
    [4, ["bundles.read", "bundles.manage"], ["bundles"]],
  ] as const) {
    const { api, close } = await bridge([...permissions], version)
    try {
      assert.equal(Object.isFrozen(api), true)
      assert.deepEqual(Object.keys(api).filter(key => !["apiVersion", "getContext", "onContext"].includes(key)), [...objects])
      if (api.bundles) {
        assert.equal(Object.isFrozen(api.bundles), true)
        assert.deepEqual(Object.keys(api.bundles), ["catalog", "state", "hosts",
          ...(permissions.some(permission => permission === "bundles.manage") ? ["request", "setActive", "installHost", "attach", "detach"] : []), "onChanged"])
      }
    } finally { close() }
  }
})

test("declared management methods use their fixed port names and inputs, without owner or plan fields", async () => {
  const { api, port, close } = await bridge(["bundles.read", "bundles.manage"])
  try {
    for (const [method, input] of [
      ["request", { action: "install", integration: "fixture", scope: "global" }],
      ["setActive", { integration: "fixture", scope: "global", enabled: true }],
      ["installHost", { integration: "fixture" }], ["attach", { integration: "fixture", offerID: "offer_fixture" }],
      ["detach", { integration: "fixture" }],
    ] as const) {
      const received = once(port, "message"), pending = api.bundles[method](input)
      const [request] = await received
      assert.deepEqual(request, { type: "api4:request", id: request.id, capability: "bundles", method, input })
      port.postMessage({ type: "api4:result", id: request.id, result: { outcome: "invalid" } })
      assert.equal((await pending).outcome, "invalid")
    }
  } finally { close() }
})

test("all bundles reads use fixed port methods; the fifth shared request and host 429 map to busy", async () => {
  const { api, port, close } = await bridge(["bundles.read", "session.images.read"])
  const requests: any[] = []
  port.on("message", value => requests.push(value))
  try {
    const pending = [api.bundles.catalog(), api.bundles.state(), api.bundles.hosts({ integration: "blender" }), api.images.status()]
    await assert.rejects(api.bundles.state(), { message: "busy" })
    while (requests.length < 4) await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(requests.map(({ type, capability, method, input }) => ({ type, capability, method, input })), [
      { type: "api4:request", capability: "bundles", method: "catalog", input: {} },
      { type: "api4:request", capability: "bundles", method: "state", input: {} },
      { type: "api4:request", capability: "bundles", method: "hosts", input: { integration: "blender" } },
      { type: "api4:request", capability: "images", method: "status", input: {} },
    ])
    for (const request of requests) port.postMessage({ type: "api4:result", id: request.id, result: "ok" })
    assert.deepEqual(await Promise.all(pending), ["ok", "ok", "ok", "ok"])
    port.on("message", request => port.postMessage({ type: "api4:result", id: request.id, error: "busy" }))
    await assert.rejects(api.bundles.catalog(), { message: "busy" })
  } finally { close() }
})

test("bundles listeners are separate; strict frozen request events stay lossless beside state invalidations", async () => {
  const { api, port, close } = await bridge(["bundles.read", "session.images.read"])
  const bundles: any[] = [], images: any[] = []
  const release = api.bundles.onChanged((value: unknown) => bundles.push(value))
  api.images.onChanged((value: unknown) => images.push(value))
  try {
    const valid = [{ kind: "state" }, { kind: "request", requestID: "opaque_1", outcome: "confirmed" },
      { kind: "request", requestID: "opaque_2", outcome: "cancelled" }]
    const invalid = [{ kind: "state", raw: "secret" }, { kind: "request", requestID: "bad/path", outcome: "failed" },
      { kind: "request", requestID: "x", outcome: "unknown" }, { kind: "request", requestID: "x", outcome: "expired", token: "secret" }]
    for (const detail of [...valid, ...invalid]) port.postMessage({ type: "bundles:changed", ...detail })
    const received = new Promise<void>(resolve => api.images.onChanged(() => resolve()))
    port.postMessage({ type: "images:changed", gallery: true, status: false })
    await received
    assert.equal(bundles.every(Object.isFrozen), true)
    assert.deepEqual(JSON.parse(JSON.stringify(bundles)), valid)
    assert.deepEqual(JSON.parse(JSON.stringify(images)), [{ gallery: true, status: false }])
    release()
    port.postMessage({ type: "bundles:changed", kind: "state" })
    const flushed = new Promise<void>(resolve => api.images.onChanged(() => resolve()))
    port.postMessage({ type: "images:changed" })
    await flushed
    assert.equal(bundles.length, 3)
  } finally { close() }
})
