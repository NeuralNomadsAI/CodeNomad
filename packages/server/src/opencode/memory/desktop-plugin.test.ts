import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { AUTOMATION_BRIDGE_PATH, createAutomationBridgeRegistration, publishAutomationBridge } from "../automation-plugin"
import { desktopPlugin } from "./desktop-plugin"
import { memoryLeaseContent } from "./activation"

type Definition = {
  name: string
  options: { namespace: string; codemode: boolean }
  input: { properties: object; additionalProperties: boolean }
  execute(input: unknown, tool: { sessionID: string; signal: AbortSignal }): Promise<{ content: string }>
}

async function until(predicate: () => boolean, label: string) {
  for (const deadline = Date.now() + 10_000; !predicate();) {
    assert(Date.now() < deadline, label)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function fixture(t: test.TestContext, { enabled = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-memory-plugin-"))
  const previous = Object.fromEntries(["LOCALAPPDATA", "XDG_RUNTIME_DIR", "WSL_DISTRO_NAME"].map(key => [key, process.env[key]]))
  process.env.LOCALAPPDATA = root
  process.env.XDG_RUNTIME_DIR = root
  delete process.env.WSL_DISTRO_NAME
  const app = Fastify({ forceCloseConnections: true }), calls: Array<{ sessionID: string; command: unknown }> = []
  // The registered transform, replayed like the native registry on every read.
  let transform: ((editor: { add(definition: Definition): void }) => void) | undefined
  let reloads = 0
  const definitions = () => {
    const added: Definition[] = []
    transform?.({ add: definition => { added.push(definition) } })
    return added
  }
  let response: { status: number; body: object } | "lost" = { status: 200, body: { result: { entries: [] } } }
  let probes = 0, disposed = 0
  let context: unknown = { supported: true, value: "MEMORY TITLES" }, hook: ((event: { sessionID: string }) => Promise<void>) | undefined
  const instructions: unknown[] = [], contexts: string[] = []
  let hookDisposed = 0
  let owned = true
  let instructionStatus = 204
  let beforeProbe = async () => {}, beforeContext = async () => {}
  let beforeInstruction = async (_kind: string) => {}
  const registration = createAutomationBridgeRegistration("http://127.0.0.1")
  app.post(AUTOMATION_BRIDGE_PATH, async (request, reply) => {
    assert.equal(request.headers["x-codenomad-automation-token"], registration.token)
    const body = request.body as { mode: string; sessionID: string; command: unknown }
    if (body.mode === "memory-probe") {
      probes++
      await beforeProbe()
      return owned ? { result: { available: true } } : reply.code(400).send({ code: "invalid" })
    }
    if (body.mode === "memory-context") {
      contexts.push(body.sessionID)
      await beforeContext()
      return context === "unavailable" ? reply.code(503).send({ code: "unreadable" }) : { result: context }
    }
    assert.equal(body.mode, "memory-input")
    calls.push({ sessionID: body.sessionID, command: body.command })
    if (response === "lost") { reply.hijack(); reply.raw.destroy(); return }
    return reply.code(response.status).send(response.body)
  })
  const url = await app.listen({ host: "127.0.0.1", port: 0 })
  const remove = await publishAutomationBridge({ ...registration, url: `${url}${AUTOMATION_BRIDGE_PATH}` })
  const presence = path.join(root, "presence")
  await mkdir(presence)
  const lease = path.join(presence, `${randomUUID()}.lease`)
  await writeFile(lease, memoryLeaseContent(enabled))
  const plugin = desktopPlugin(presence)
  const cleanup = await plugin.setup!({ session: {
    hook: async (kind: string, callback: typeof hook) => { assert.equal(kind, "prompt"); hook = callback; return { dispose() { hookDisposed++ } } },
    instructions: { entry: {
      put: async (input: unknown) => { instructions.push(input); await beforeInstruction("put"); if (instructionStatus !== 204) throw new Error("503") },
      remove: async (input: unknown) => { instructions.push(input); await beforeInstruction("remove"); if (instructionStatus !== 204) throw new Error("503") },
    } },
  }, tool: {
    transform: async (callback: typeof transform) => {
      transform = callback
      return { dispose: async () => { disposed++; transform = undefined } }
    },
    reload: async () => { reloads++ },
  } } as never) as () => Promise<void>
  t.after(async () => {
    await cleanup(); await remove(); await app.close()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(root, { recursive: true, force: true })
  })
  assert.equal(plugin.id, "codenomad.memory")
  assert.equal(definitions().length, enabled ? 1 : 0)
  const tool = definitions()[0]!
  if (enabled) {
    assert.equal(tool.name, "memory")
    assert.deepEqual(tool.options, { namespace: "codenomad", codemode: false })
    assert.equal(tool.input.additionalProperties, false)
    assert.equal("sessionId" in tool.input.properties, false)
    assert.equal("sessionID" in tool.input.properties, false)
  }
  return { tool, calls, setResponse(value: typeof response) { response = value }, cleanup,
    definitions, reloads: () => reloads, request: (value: boolean) => writeFile(lease, memoryLeaseContent(value)),
    instructions, contexts, setContext(value: unknown) { context = value }, prompt: (sessionID: string) => hook!({ sessionID }), hookDisposed: () => hookDisposed,
    setOwned(value: boolean) { owned = value },
    setInstructionStatus(value: number) { instructionStatus = value },
    beforeProbe(value: typeof beforeProbe) { beforeProbe = value },
    beforeContext(value: typeof beforeContext) { beforeContext = value },
    beforeInstruction(value: typeof beforeInstruction) { beforeInstruction = value },
    probes: () => probes, disposed: () => disposed,
    execute: (input: object, signal = new AbortController().signal) => tool.execute({ scope: "global", ...input }, { sessionID: "ses_native", signal }) }
}

test("native memory tools route every action using only the execution session and dispose with presence", async t => {
  const f = await fixture(t)
  await f.execute({ action: "list" })
  for (const query of ["entry_id", "Exact title"]) await f.execute({ action: "read", query })
  const content = { title: "Editor", type: "preference", text: "Use Vim." }
  await f.execute({ action: "save", ...content })
  await f.execute({ action: "save", ...content, id: "entry_id", revision: "a".repeat(64) })
  await f.execute({ action: "delete", id: "entry_id", revision: "b".repeat(64) })
  assert.deepEqual(f.calls, [
    { sessionID: "ses_native", command: { action: "list", scope: "global" } },
    ...["entry_id", "Exact title"].map(query => ({ sessionID: "ses_native", command: { action: "read", scope: "global", query } })),
    { sessionID: "ses_native", command: { action: "save", scope: "global", content } },
    { sessionID: "ses_native", command: { action: "save", scope: "global", id: "entry_id", revision: "a".repeat(64), content } },
    { sessionID: "ses_native", command: { action: "delete", scope: "global", id: "entry_id", revision: "b".repeat(64) } },
  ])
  const before = f.probes()
  for (const input of [{ action: "list", sessionID: "forged" }, { action: "list", sessionId: "forged" },
    { action: "delete", id: "entry_id" }, { action: "save", title: "Missing text" }, { action: "list", projectId: "forged" }]) {
    await assert.rejects(f.execute(input), /Invalid memory input/)
  }
  assert.equal(f.probes(), before, "invalid or forged input never reaches discovery")
  await f.cleanup()
  assert.equal(f.disposed(), 1)
})

test("the native tool follows the backend's memory request while the prompt hook keeps clearing stale instructions", async t => {
  const f = await fixture(t, { enabled: false })
  assert.equal(f.definitions().length, 0, "disabled memory registers no model-visible tool")
  f.setContext({ supported: true, value: null })
  await f.prompt("ses_disabled")
  assert.deepEqual(f.instructions, [{ sessionID: "ses_disabled", key: "codenomad.memory" }], "the prompt hook still removes stale memory instructions")
  await f.request(true)
  await until(() => f.definitions().length === 1, "enabling memory registers the tool")
  assert.equal(f.definitions()[0]!.name, "memory")
  const reloads = f.reloads()
  assert.ok(reloads >= 1, "the change reaches the native registry through a reload")
  await new Promise(resolve => setTimeout(resolve, 2_500))
  assert.equal(f.reloads(), reloads, "an unchanged request never reloads")
  await f.request(false)
  await until(() => f.definitions().length === 0, "disabling memory withdraws the tool")
  await f.cleanup()
  assert.equal(f.disposed(), 1)
})

test("awaited prompt hook resolves each native child's own context, removes only its key and follows presence lifetime", async t => {
  const f = await fixture(t)
  await f.prompt("ses_native_child")
  assert.deepEqual(f.contexts, ["ses_native_child"])
  assert.deepEqual(f.instructions, [{ sessionID: "ses_native_child", key: "codenomad.memory", value: "MEMORY TITLES" }])
  f.setContext({ supported: true, value: null })
  await f.prompt("ses_native_child")
  assert.deepEqual(f.instructions[1], { sessionID: "ses_native_child", key: "codenomad.memory" })
  f.setContext({ supported: false })
  await f.prompt("ses_native_child")
  assert.equal(f.instructions.length, 2)
  f.setContext("unavailable")
  await f.prompt("ses_native_child")
  assert.deepEqual(f.instructions[2], { sessionID: "ses_native_child", key: "codenomad.memory" }, "failed preparation clears stale memory and preserves native admission")
  f.setOwned(false)
  await f.prompt("ses_unowned")
  assert.deepEqual(f.instructions[3], { sessionID: "ses_unowned", key: "codenomad.memory" }, "an explicit ownership refusal clears stale memory without blocking unrelated Locations")
  await f.cleanup()
  assert.equal(f.hookDisposed(), 1)
})

test("native prompt hooks tolerate failed memory puts and removals without replaying a put", async t => {
  const f = await fixture(t)
  f.setInstructionStatus(503)
  await f.prompt("ses_native_child")
  assert.deepEqual(f.instructions, [
    { sessionID: "ses_native_child", key: "codenomad.memory", value: "MEMORY TITLES" },
    { sessionID: "ses_native_child", key: "codenomad.memory" },
  ])
  f.setContext({ supported: true, value: null })
  await f.prompt("ses_native_child")
  assert.equal(f.instructions.length, 3, "disabled cleanup is attempted once even when it fails")
})

test("agent-facing errors preserve capacity titles and never replay uncertain writes", async t => {
  const f = await fixture(t)
  f.setResponse({ status: 403, body: { code: "disabled", error: "private path" } })
  await assert.rejects(f.execute({ action: "save", title: "Editor", type: "fact", text: "Vim" }), /disabled.*Preferences/)
  f.setResponse({ status: 409, body: { code: "full", titles: ["Editor", "Project checks"] } })
  await assert.rejects(f.execute({ action: "save", title: "Editor", type: "fact", text: "Vim" }), /Merge or delete.*Editor.*Project checks/)
  f.setResponse({ status: 409, body: { code: "conflict" } })
  await assert.rejects(f.execute({ action: "delete", id: "entry_id", revision: "a".repeat(64) }), /read the current entry/)
  f.setResponse("lost")
  const before = f.calls.length
  await assert.rejects(f.execute({ action: "save", title: "Editor", type: "fact", text: "Vim" }), /Do not replay.*List\/read/)
  assert.equal(f.calls.length, before + 1, "a lost mutation response produces exactly one dispatch")
  await assert.rejects(f.execute({ action: "list" }), /unavailable/)
})

test("cancelling the tool during ownership discovery sends zero memory-input mutations", async t => {
  const f = await fixture(t), controller = new AbortController()
  let reached!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { reached = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  f.beforeProbe(async () => { reached(); await gate })
  const pending = f.execute({ action: "save", title: "Cancelled", type: "fact", text: "Never publish" }, controller.signal)
  const rejected = assert.rejects(pending)
  await started
  controller.abort()
  release()
  await rejected
  assert.deepEqual(f.calls, [])
  const before = f.probes()
  await assert.rejects(f.execute({ action: "delete", id: "entry_id", revision: "a".repeat(64) }, controller.signal))
  assert.equal(f.probes(), before, "already cancelled tools never discover a backend")
})

for (const stage of ["probe", "context", "put", "remove", "cleanup"] as const) {
  test(`native prompt admission bounds a hanging ${stage} with the same memory budget`, async t => {
    const f = await fixture(t)
    let reached!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { reached = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const hang = async () => { reached(); await gate }
    if (stage === "probe") f.beforeProbe(hang)
    if (stage === "context") f.beforeContext(hang)
    if (stage === "remove") f.setContext({ supported: true, value: null })
    if (stage === "put" || stage === "remove" || stage === "cleanup") f.beforeInstruction(async kind => {
      if (stage === "cleanup" && kind === "put") throw new Error("uncertain put")
      await hang()
    })
    t.mock.timers.enable({ apis: ["setTimeout"] })
    try {
      const pending = f.prompt("ses_child")
      await started
      t.mock.timers.tick(2_000)
      await pending
      const count = f.instructions.length
      release()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(f.instructions.length, count, "expired hooks never issue a late put/cleanup")
      assert.equal(count, stage === "probe" || stage === "context" ? 0 : stage === "cleanup" ? 2 : 1)
    } finally { release(); t.mock.timers.reset() }
  })
}
