import assert from "node:assert/strict"
import { test } from "node:test"
import type { FastifyRequest } from "fastify"
import { EventBus } from "../events/bus"
import { BundlesTransport } from "./bundles-transport"
import { BundlesLifecycle, type BundlesConfirmation } from "./bundles-lifecycle"
import { catalogEntry, catalogOf } from "../opencode/integrations/catalog-fixture"

const extension = "test.bundles", digest = "a".repeat(64)
const request = (session = "human") => ({ headers: { cookie: session } }) as FastifyRequest
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function harness() {
  let principal: string | null = "human", directory = "/project", owned = true, current = true, at = 0
  let prepared = 0, dispatched = 0, reads = 0, disposed = 0
  let stalled: Promise<void> | undefined
  const leases: AbortController[] = [], bus = new EventBus()
  const connection = { assertCurrent() { if (!current) throw new Error("secret connection") }, client: { session: {
    async get() { reads++; await stalled; return { id: "ses_test", title: "Conversation", location: { directory } } },
  } } }
  const lifecycle = new BundlesLifecycle({ now: () => at, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as NodeJS.Timeout) })
  const transport = new BundlesTransport({ lifecycle, eventBus: bus, readTimeoutMs: 30,
    auth: { getSessionFromRequest: req => principal && req.headers.cookie === principal ? { username: "human", sessionId: principal } : null },
    catalog: { async read() { return { state: "fresh", catalog: catalogOf(catalogEntry("blender")) } } },
    store: { async captureReadAuthority() {
      const controller = new AbortController(); leases.push(controller)
      return { canManage: true, signal: controller.signal, assertCurrent: () => controller.signal.throwIfAborted(),
        async revalidate() { controller.signal.throwIfAborted() }, dispose() { disposed++; controller.abort() } }
    } }, workspaceManager: { async getSharedServiceConnection() { return connection as never }, async ownsLocation() { return owned } },
    actions: { accepts: () => true, async prepare(context, _action, outer) {
      prepared++; await context.authority.revalidate()
      const target = { instance: "instance", session: "ses_test", location: "/project", connection: "one", integration: "blender", scope: "global" as const, range: "1", documentDigest: "one" }
      return { target, display: { action: "install", integration: "Blender", scope: "global", version: "1", conversation: "Conversation" },
        async readTarget() { await context.authority.revalidate(); return target },
        async dispatch(authority, submitted) { outer.throwIfAborted(); await authority.revalidate(); authority.assertCurrent(); dispatched++; submitted() } }
    } },
  })
  const frames: string[] = []
  const open = (req = request()) => {
    const own: string[] = [], stream = {}, close = transport.openStream(req, stream, text => { own.push(text); frames.push(text) })
    const owner = own[0] ? JSON.parse(own[0].split("data: ")[1]).owner as string : ""
    return { owner, stream, close, frames: own }
  }
  const mount = (owner: string, req = request()) => transport.mount(req, extension,
    { owner, digest, instanceId: "instance", sessionID: "ses_test" }, AbortSignal.timeout(1000))
  const manage = (owner: string, mountID: string) => transport.manage(request(), extension,
    { owner, mountID, method: "request", input: { action: "install", integration: "blender", scope: "global" } })
  return { transport, bus, frames, leases, open, mount, manage, request,
    state: () => ({ prepared, dispatched, reads, disposed }), advance(ms: number) { at += ms },
    set(options: { principal?: string | null; directory?: string; owned?: boolean; current?: boolean; stalled?: Promise<void> }) {
      if ("principal" in options) principal = options.principal!
      if (options.directory !== undefined) directory = options.directory
      if (options.owned !== undefined) owned = options.owned
      if (options.current !== undefined) current = options.current
      if ("stalled" in options) stalled = options.stalled
    } }
}

test("owner capabilities require a real principal and bind stream, session, extension and mount", async () => {
  const h = harness()
  try {
    h.set({ principal: "auth-disabled" }); assert.equal(h.open(request("auth-disabled")).owner, "")
    h.set({ principal: null }); assert.equal(h.open().owner, "")
    h.set({ principal: "human" })
    const a = h.open(), b = h.open(), mounted = await h.mount(a.owner)
    assert.match(a.owner, /^[a-f0-9]{64}$/); assert.notEqual(a.owner, b.owner)
    assert.notEqual(mounted.mountID, a.owner)
    await assert.rejects(h.manage(b.owner, mounted.mountID))
    await assert.rejects(h.transport.manage(request(), "other.extension", { owner: a.owner, ...mounted, method: "detach", input: { integration: "blender" } }))
    await assert.rejects(h.mount(a.owner, request("other")))
    const ack = await h.manage(a.owner, mounted.mountID)
    assert.equal(ack.outcome, "confirming"); await turn(); assert.equal(h.state().prepared, 0)
    a.close(); await assert.rejects(h.manage(a.owner, mounted.mountID))
    assert.equal(h.state().disposed, 1)
  } finally { h.transport.dispose() }
})

test("ACK requires owner-only start; a 30-second human wait survives preparation's deadline and remains private", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const h = harness()
  try {
    const a = h.open(), b = h.open(), mounted = await h.mount(a.owner)
    const ack = await h.manage(a.owner, mounted.mountID); assert.equal(ack.outcome, "confirming")
    if (ack.outcome !== "confirming") return
    await assert.rejects(h.transport.control(request(), extension, { owner: b.owner, ...mounted, command: "start", requestID: ack.requestID }))
    await h.transport.control(request(), extension, { owner: a.owner, ...mounted, command: "start", requestID: ack.requestID })
    await turn()
    const event = a.frames.map(frame => JSON.parse(frame.split("data: ")[1])).find(event => event.view)
    const view = event.view as BundlesConfirmation
    assert.equal(view.requestID, ack.requestID); assert.equal(b.frames.length, 1)
    await h.transport.control(request(), extension, { owner: a.owner, ...mounted, command: "confirm", planID: view.planID })
    assert.equal(h.state().dispatched, 0)
    await h.transport.control(request(), extension, { owner: a.owner, ...mounted, command: "displayed", planID: view.planID })
    h.advance(30_000); t.mock.timers.tick(30_000)
    await h.transport.control(request(), extension, { owner: a.owner, ...mounted, command: "confirm", planID: view.planID })
    await turn(); assert.equal(h.state().dispatched, 1)
    await assert.rejects(h.transport.control(request(), extension, { owner: a.owner, ...mounted, command: "confirm", planID: view.planID }))
    assert.equal(h.state().dispatched, 1)
    assert.equal(a.frames.filter(frame => frame.includes('"outcome":"confirmed"')).length, 1)
  } finally { h.transport.dispose() }
})

test("all windows share one arbiter for removal too; detach never reaches the builder", async () => {
  const h = harness()
  try {
    const a = h.open(), b = h.open(), one = await h.mount(a.owner), two = await h.mount(b.owner)
    assert.deepEqual(await h.transport.manage(request(), extension, { owner: a.owner, ...one, method: "detach", input: { integration: "blender" } }), { outcome: "invalid" })
    assert.equal((await h.transport.manage(request(), extension, { owner: a.owner, ...one, method: "request", input: { action: "remove", integration: "blender", scope: "global" } })).outcome, "confirming")
    assert.equal(h.state().prepared, 0)
    assert.deepEqual(await h.manage(b.owner, two.mountID), { outcome: "busy" })
    a.close(); assert.equal((await h.manage(b.owner, two.mountID)).outcome, "confirming")
  } finally { h.transport.dispose() }
})

test("session movement/deletion, native disconnect, workspace stop, consent and auth loss revoke mounts", async () => {
  for (const kind of ["moved", "deleted", "disconnected", "stopped", "consent", "auth", "ownership", "connection", "location"] as const) {
    const h = harness()
    try {
      const a = h.open(), mounted = await h.mount(a.owner)
      switch (kind) {
        case "moved": case "deleted": h.bus.publish({ type: "instance.event", instanceId: "instance", event: { type: `session.${kind}`, data: { sessionID: "ses_test" } } } as never); break
        case "disconnected": h.bus.publish({ type: "instance.eventStatus", instanceId: "instance", status: "disconnected", generation: 1 }); break
        case "stopped": h.bus.publish({ type: "workspace.stopped", workspaceId: "instance" }); break
        case "consent": h.leases[0].abort(); break
        case "auth": h.set({ principal: null }); break
        case "ownership": h.set({ owned: false }); break
        case "connection": h.set({ current: false }); break
        case "location": h.set({ directory: "/another-owned-project" }); break
      }
      if (kind === "ownership" || kind === "location") {
        const ack = await h.manage(a.owner, mounted.mountID)
        assert.equal(ack.outcome, "confirming")
        if (ack.outcome === "confirming") await h.transport.control(request(), extension,
          { owner: a.owner, ...mounted, command: "start", requestID: ack.requestID })
        await turn()
      }
      await assert.rejects(h.manage(a.owner, mounted.mountID), kind)
      assert.equal(h.state().prepared, 0)
    } finally { h.transport.dispose() }
  }
})

test("native reads time out and late results cannot resurrect revoked mounts; mount count is bounded", async () => {
  const h = harness()
  try {
    const a = h.open(), mounts = []
    for (let i = 0; i < 8; i++) mounts.push(await h.mount(a.owner))
    await assert.rejects(h.mount(a.owner))
    await h.transport.control(request(), extension, { owner: a.owner, ...mounts[0], command: "dispose" })
    await h.mount(a.owner)
    let release!: () => void
    h.set({ stalled: new Promise(resolve => { release = resolve }) })
    const ack = await h.manage(a.owner, mounts[1].mountID)
    assert.equal(ack.outcome, "confirming")
    if (ack.outcome === "confirming") await h.transport.control(request(), extension,
      { owner: a.owner, ...mounts[1], command: "start", requestID: ack.requestID })
    await new Promise(resolve => setTimeout(resolve, 50))
    await assert.rejects(h.manage(a.owner, mounts[1].mountID))
    release(); await turn(); h.set({ stalled: undefined })
    await assert.rejects(h.manage(a.owner, mounts[1].mountID))
    assert.equal(h.state().prepared, 0)
  } finally { h.transport.dispose() }
})

test("only explicit owner userRemount clears cutoff, revokes the old mount and preserves rate history", async () => {
  const h = harness()
  try {
    const a = h.open()
    let mounted = await h.mount(a.owner)
    for (let index = 0; index < 3; index++) {
      const ack = await h.manage(a.owner, mounted.mountID)
      assert.equal(ack.outcome, "confirming")
      if (ack.outcome !== "confirming") return
      await h.transport.control(request(), extension, { owner: a.owner, ...mounted, command: "start", requestID: ack.requestID })
      await turn()
      const views = a.frames.map(frame => JSON.parse(frame.split("data: ")[1])).filter(event => event.view)
      await h.transport.control(request(), extension, { owner: a.owner, ...mounted, command: "cancel", planID: views.at(-1).view.planID })
    }
    assert.deepEqual(await h.manage(a.owner, mounted.mountID), { outcome: "busy" })
    await h.transport.control(request(), extension, { owner: a.owner, ...mounted, command: "dispose" })
    mounted = await h.mount(a.owner)
    assert.deepEqual(await h.manage(a.owner, mounted.mountID), { outcome: "busy" })
    await h.transport.control(request(), extension, { owner: a.owner, ...mounted, command: "userRemount" })
    await assert.rejects(h.manage(a.owner, mounted.mountID))
    mounted = await h.mount(a.owner)
    assert.equal((await h.manage(a.owner, mounted.mountID)).outcome, "confirming")
    // Six attempts have counted so far, including the two cutoff refusals.
    for (let index = 0; index < 4; index++) assert.deepEqual(await h.manage(a.owner, mounted.mountID), { outcome: "busy" })
    await h.transport.control(request(), extension, { owner: a.owner, ...mounted, command: "userRemount" })
    mounted = await h.mount(a.owner)
    assert.deepEqual(await h.manage(a.owner, mounted.mountID), { outcome: "busy" })
  } finally { h.transport.dispose() }
})

test("owner registry is bounded and refuses a second capability for the same actual stream", () => {
  const h = harness()
  try {
    const a = h.open(), extra: string[] = []
    h.transport.openStream(request(), a.stream, text => extra.push(text))
    assert.equal(extra.length, 0)
    for (let i = 1; i < 128; i++) assert(h.open().owner)
    assert.equal(h.open().owner, "")
    a.close(); assert(h.open().owner)
  } finally { h.transport.dispose() }
})

test("expired auth releases its owner and a repeated old close cannot revoke a replacement stream owner", async () => {
  const h = harness()
  try {
    const a = h.open(), mounted = await h.mount(a.owner)
    h.set({ principal: null }); await assert.rejects(h.manage(a.owner, mounted.mountID))
    assert.equal(h.state().disposed, 1)
    h.set({ principal: "human" })
    const frames: string[] = [], close = h.transport.openStream(request(), a.stream, frame => frames.push(frame))
    const owner = JSON.parse(frames[0].split("data: ")[1]).owner
    a.close(); a.close()
    const next = await h.mount(owner)
    assert.equal((await h.manage(owner, next.mountID)).outcome, "confirming")
    close()
  } finally { h.transport.dispose() }
})
