import assert from "node:assert/strict"
import test from "node:test"
import type { Plugin } from "@opencode/plugin"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"
import type * as Tool from "@opencode/plugin/promise/tool"
import { installNativeFamilyGates, type NativeFamilyBoundary, type NativeFamilyFence,
  type NativeFamilyPolicy } from "./native-family-gates"

// Official-shaped deterministic stubs only. These test gating/control flow, NOT
// native host qualification, actual signed membership or transport enforcement.
type Membership = { readonly family: string }
type Permit = { readonly hostPolicy: string }
type Hook = (event: never) => void | Promise<void>

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

function toolContext(): Tool.ToolContext {
  return { sessionID: "ses_owned_raw_child" as Tool.ToolContext["sessionID"],
    messageID: "msg_actual_native" as Tool.ToolContext["messageID"], id: "call_actual_native" as Tool.ToolContext["id"],
    agent: "worker" as Tool.ToolContext["agent"], signal: new AbortController().signal, progress: async () => {} }
}

const identity = toolContext()
const model: SessionHooks["context"]["model"] = { id: "native-model" as SessionHooks["context"]["model"]["id"],
  providerID: "native-provider" as SessionHooks["context"]["model"]["providerID"] }
const request = { sessionID: identity.sessionID, model, system: [], messages: [], options: {} }
const contextEvent: SessionHooks["context"] = { ...request, agent: identity.agent, tools: { native: { description: "native", input: { type: "object" } } } }
const shellEvent: ShellCreateBefore = { command: "same command cannot establish session identity", cwd: "D:/same-owned-folder",
  timeout: 1000, shell: "pwsh", env: { SAME: "not owner evidence" } }
const unavailable = async () => { throw new Error("Gate must not issue client session mutations/reads") }

async function fixture(execute?: Tool.Info["execute"]) {
  const hooks = new Map<keyof SessionHooks, Hook>()
  const toolHooks = new Map<string, Hook>()
  let shellHook: ((event: ShellCreateBefore) => void | Promise<void>) | undefined
  const calls: NativeFamilyBoundary[] = []
  const preparations: NativeFamilyBoundary[] = []
  const environments: Array<{ sessionID: string; boundary: string }> = []
  const fences: NativeFamilyFence[] = []
  const executions: Array<{ input: unknown; context: Tool.ToolContext }> = []
  const disposed: string[] = []
  let currentOwner = true
  const result: Tool.Result = { output: { native: true }, metadata: { original: true },
    content: [{ type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png" }, { type: "text", text: "native result" }] }
  const originals: Array<Tool.Info & { readonly id: string }> = ["execute", "subagent", "native_mcp_tool"].map(id => ({
    id, name: id, description: `native ${id}`, input: { type: "object", properties: { input: { type: "string" } } },
    output: { type: "object" }, options: { codemode: true, pinned: true, permission: id },
    execute: async (input, context) => {
      executions.push({ input, context })
      if (execute) return execute(input, context)
      await context.progress({ native: "unchanged" })
      return result
    },
  }))
  let definitions = originals.map(tool => ({ ...tool }))
  const editor: Tool.ToolEditor = {
    list: () => definitions, get: id => definitions.find(tool => tool.id === id), namespace: () => {},
    add: () => { throw new Error("Gates must not add tools") }, remove: () => { throw new Error("Gates must not remove tools") },
    update: (id, callback) => {
      const definition = definitions.find(tool => tool.id === id)
      if (!definition) return
      const draft = { ...definition }; callback(draft)
      definitions = definitions.map(tool => tool.id === id ? draft : tool)
    },
  }
  let transform: ((editor: Tool.ToolEditor) => void) | undefined
  const ctx: Pick<Plugin.Context, "session" | "tool" | "shell"> = {
    session: { create: unavailable, get: unavailable, remove: unavailable, switchAgent: unavailable, switchModel: unavailable,
      prompt: unavailable, generate: unavailable, command: unavailable, compact: unavailable, synthetic: unavailable,
      interrupt: unavailable, update: unavailable, move: unavailable, wait: unavailable, context: unavailable,
      hook: async (name, callback) => {
        hooks.set(name, callback as Hook)
        return { dispose: async () => { disposed.push(name); hooks.delete(name) } }
      },
    },
    tool: { list: async () => definitions, reload: async () => { definitions = originals.map(tool => ({ ...tool })); transform?.(editor) },
      hook: async (name, callback) => {
        toolHooks.set(name, callback as Hook)
        return { dispose: async () => { disposed.push(`tool.${name}`); toolHooks.delete(name) } }
      },
      transform: async callback => {
        transform = callback; callback(editor)
        return { dispose: async () => { disposed.push("tool.transform"); definitions = originals.map(tool => ({ ...tool })) } }
      },
    },
    shell: { hook: async (_name, callback) => {
      shellHook = callback
      return { dispose: async () => { disposed.push("shell.create.before"); shellHook = undefined } }
    } },
  }
  const policy: NativeFamilyPolicy<Membership, Permit> = {
    assertCurrent: () => { if (!currentOwner) throw new Error("native owner/lifecycle revoked") },
    resolve: async (boundary, fence) => {
      fence.assertCurrent(); calls.push(boundary); fences.push(fence)
      return { scope: "owned", membership: { family: "owned native family" } }
    },
    prepare: async (boundary, resolution, fence) => {
      fence.assertCurrent(); preparations.push(boundary)
      const sessionID = boundary.boundary === "tool.executor" ? boundary.context.sessionID
        : boundary.boundary === "shell.create.before" ? undefined : boundary.event.sessionID
      if (sessionID && resolution.scope === "owned") environments.push({ sessionID, boundary: boundary.boundary })
      fence.assertCurrent()
    },
  }
  const registration = await installNativeFamilyGates(ctx, policy)
  const captured = definitions.slice()
  const emit = async <Name extends keyof SessionHooks>(name: Name, event: SessionHooks[Name]) => {
    await hooks.get(name)?.(event as never)
  }
  const emitTool = async () => { await toolHooks.get("execute.before")?.({ sessionID: identity.sessionID,
    messageID: identity.messageID, id: identity.id, agent: identity.agent, tool: "subagent", input: { prompt: "raw family" } } as never) }
  const emitShell = async (event = shellEvent) => { await shellHook?.(event) }
  return { ctx, policy, registration, captured, originals, result, executions, calls, preparations, environments, fences,
    emit, emitTool, emitShell, hooks, disposed, revoke: () => { currentOwner = false } }
}

test("all official session assembly/dispatch hooks register without provider or primary-only filters", async () => {
  const f = await fixture()
  assert.deepEqual([...f.hooks.keys()], ["prompt", "context", "compaction", "generate", "title", "model.request", "http.request",
    "http.response", "experimental.ws.handshake", "experimental.ws.send", "experimental.ws.receive", "retry"])
  await f.emit("prompt", { sessionID: identity.sessionID, messageID: identity.messageID, prompt: { text: "native" }, delivery: "steer" })
  await f.emit("context", contextEvent)
  await f.emit("compaction", contextEvent)
  await f.emit("generate", contextEvent)
  await f.emit("title", request)
  assert.equal(f.calls.length, 5)
  assert.equal(f.environments.length, 5)
  assert.equal(f.calls[1].boundary, "context")
  assert.equal(f.calls[1].boundary === "context" && f.calls[1].event, contextEvent)
  assert.deepEqual(contextEvent.system, [])
  assert.equal(contextEvent.tools.native.description, "native")
})

test("primary AND every auxiliary kind receive uncached fresh ENV at HTTP/WS/model boundaries", async () => {
  const f = await fixture()
  for (const kind of ["primary", "compaction", "title", "generate"] as const) {
    const base = { sessionID: identity.sessionID, agent: identity.agent, model, kind }
    const req = new Request("https://native.invalid/model", { method: "POST", body: "native body" })
    const response = new Response("native response")
    await f.emit("model.request", { ...base, headers: {} })
    await f.emit("http.request", { ...base, request: req })
    await f.emit("http.response", { ...base, request: req, response })
    await f.emit("experimental.ws.handshake", { ...base, url: "wss://native.invalid", headers: {} })
    await f.emit("experimental.ws.send", { ...base, frame: "native frame" })
    await f.emit("experimental.ws.receive", { ...base, frame: "native frame" })
    assert.equal(await req.text(), "native body", "gate never consumes a provider body")
    assert.equal(await response.text(), "native response")
  }
  await f.emit("context", contextEvent)
  await f.emit("context", contextEvent)
  assert.equal(f.calls.length, 26)
  assert.equal(f.preparations.length, 26)
  assert.equal(f.environments.length, 26)
  assert(f.environments.every(entry => entry.sessionID === identity.sessionID))
})

test("retry admission is fresh, propagates denial and never rewrites native retry policy", async () => {
  const f = await fixture()
  const event: SessionHooks["retry"] = { sessionID: identity.sessionID, agent: identity.agent, model,
    error: { type: "provider.rate-limit", message: "native retry" }, attempt: 2, decision: { retry: true, delay: 100 } }
  const decision = event.decision
  await f.emit("retry", event)
  assert.equal(f.environments.length, 1)
  assert.equal(event.decision, decision)
  f.revoke()
  await assert.rejects(f.emit("retry", event), /owner\/lifecycle revoked/)
  assert.equal(event.decision, decision)
})

test("tool before hook and every captured direct/inner-Code-Mode executor separately guard family and freshly prepare", async () => {
  const f = await fixture()
  await f.emitTool()
  const catalog = Object.fromEntries(f.captured.map(tool => [tool.id, tool.execute]))
  const tool = toolContext()
  for (const [index, definition] of f.captured.entries()) {
    for (const key of Object.keys(f.originals[index]) as Array<keyof Tool.Info>) {
      if (key !== "execute") assert.equal(definition[key], f.originals[index][key])
    }
    assert.equal(catalog[definition.id], definition.execute)
    const input = { native: "exact original input" }
    assert.equal(await catalog[definition.id](input, tool), f.result)
    assert.equal(f.executions[index].input, input)
    assert.equal(f.executions[index].context.signal, tool.signal)
  }
  assert.deepEqual(f.preparations.map(boundary => boundary.boundary), ["tool.execute.before", "tool.executor", "tool.executor", "tool.executor"])
  assert.equal(f.environments.length, 4)
})

test("raw owned descendants cannot skip policy resolution/ENV; unrelated requires positive trusted policy", async () => {
  const f = await fixture()
  const resolve = f.policy.resolve
  f.policy.resolve = async (...args) => { await resolve(...args); return { scope: "unrelated", permit: { hostPolicy: "explicit trusted unrelated decision" } } }
  await f.emit("context", contextEvent)
  assert.equal(f.calls.length, 1)
  assert.equal(f.preparations.length, 1, "unrelated still crosses mandatory policy preparation")
  assert.equal(f.environments.length, 0, "trusted unrelated policy, not envelope absence, chooses no owned-family ENV")
  f.policy.resolve = async () => undefined as never
  await assert.rejects(f.emit("context", contextEvent), /Unknown native family membership\/policy/)
  await assert.rejects(f.captured[0].execute({}, toolContext()), /Unknown native family membership\/policy/)
  assert.equal(f.executions.length, 0)
})

test("authorization/ENV errors propagate unchanged from every hook, not additive-context catches", async t => {
  for (const boundary of ["context", "model.request", "http.request", "experimental.ws.handshake", "tool"] as const) await t.test(boundary, async () => {
    const f = await fixture()
    const error = new Error("signed ownership/ENV denied")
    f.policy.prepare = async () => { throw error }
    const base = { sessionID: identity.sessionID, agent: identity.agent, model, kind: "generate" as const }
    const pending = boundary === "context" ? f.emit("context", contextEvent)
      : boundary === "model.request" ? f.emit("model.request", { ...base, headers: {} })
      : boundary === "http.request" ? f.emit("http.request", { ...base, request: new Request("https://native.invalid") })
      : boundary === "experimental.ws.handshake" ? f.emit("experimental.ws.handshake", { ...base, headers: {}, url: "wss://native.invalid" })
      : f.captured[0].execute({}, toolContext())
    await assert.rejects(pending, actual => actual === error)
    assert.equal(f.executions.length, 0)
  })
})

test("revocation/disposal/abort during asynchronous ENV preparation prevents actual executor", async t => {
  for (const cause of ["revoke", "dispose", "abort"] as const) await t.test(cause, async () => {
    const entered = deferred()
    const gate = deferred()
    const f = await fixture()
    f.policy.prepare = async (_boundary, _resolution, fence) => { entered.resolve(); await gate.promise; fence.assertCurrent() }
    const controller = new AbortController()
    const pending = f.captured[0].execute({}, { ...toolContext(), signal: controller.signal })
    await entered.promise
    if (cause === "revoke") f.revoke()
    if (cause === "dispose") await f.registration.dispose()
    if (cause === "abort") controller.abort(new Error("native signal cancelled"))
    gate.resolve()
    await assert.rejects(pending, /revoked|retired|native signal cancelled/)
    assert.equal(f.executions.length, 0)
  })
})

test("captured executor is retired before registrations dispose; hook removal is NOT persistent enforcement", async () => {
  const f = await fixture()
  await f.registration.dispose()
  await assert.rejects(f.captured[0].execute({}, toolContext()), /retired/)
  assert.equal(f.executions.length, 0)
  assert.equal(f.hooks.size, 0)
  const count = f.calls.length
  await f.emit("context", contextEvent)
  assert.equal(f.calls.length, count, "removed native hooks cannot enforce future calls")
  assert.equal(f.disposed.length, 15)
  await f.registration.dispose()
  assert.equal(f.disposed.length, 15)
})

test("revocation while original native executor awaits rejects progress and returned success, preserving native error", async () => {
  const gate = deferred()
  const entered = deferred()
  const f = await fixture(async (_input, context) => { entered.resolve(); await gate.promise; await context.progress({ native: true }); return {} })
  const pending = f.captured[0].execute({}, toolContext())
  await entered.promise; await f.registration.dispose(); gate.resolve()
  await assert.rejects(pending, /retired/)
  const nativeError = { native: "original error identity" }
  const original = await fixture(async () => { throw nativeError })
  await assert.rejects(original.captured[0].execute({}, toolContext()), actual => actual === nativeError)
})

test("Shell has no session identity: owned or unknown is closed; cwd/command/env never imply membership", async () => {
  const f = await fixture()
  await assert.rejects(f.emitShell(), /no attributable session identity/)
  assert.equal(f.preparations.length, 0)
  assert.equal(f.calls[0].boundary, "shell.create.before")
  const resolve = f.policy.resolve
  f.policy.resolve = async () => undefined as never
  await assert.rejects(f.emitShell(), /Unknown native family membership\/policy/)
  // A real trusted implementation may permit proven unrelated origin through
  // its private host policy, never by guessing from these identical shell fields.
  f.policy.resolve = async (...args) => { await resolve(...args); return { scope: "unrelated", permit: { hostPolicy: "private origin policy" } } }
  await f.emitShell(shellEvent)
  assert.equal(f.preparations.length, 1)
  assert.equal(f.environments.length, 0)
})

test("missing policy and unsigned/async synchronous assertions fail closed", async () => {
  const f = await fixture()
  await assert.rejects(installNativeFamilyGates(f.ctx, {} as NativeFamilyPolicy<Membership, Permit>), /Missing trusted native family policy/)
  f.policy.assertCurrent = () => true
  await assert.rejects(f.emit("context", contextEvent), /Invalid synchronous native family fence/)
  f.policy.assertCurrent = async () => {}
  await assert.rejects(f.captured[0].execute({}, toolContext()), /Invalid synchronous native family fence/)
  assert.equal(f.executions.length, 0)
})

test("a cached/unsigned preparation receipt cannot substitute for the mandatory fresh host operation", async () => {
  const f = await fixture()
  f.policy.prepare = async () => ({ admitted: true, cachedReceipt: true }) as never
  await assert.rejects(f.emit("context", contextEvent), /Invalid native family preparation acknowledgement/)
  await assert.rejects(f.captured[0].execute({}, toolContext()), /Invalid native family preparation acknowledgement/)
  assert.equal(f.executions.length, 0)
  assert.equal(f.environments.length, 0)
})

test("boundary fences retire after hook/executor settlement; official transform replay wraps new snapshots", async () => {
  const f = await fixture()
  await f.emit("context", contextEvent)
  assert.throws(f.fences[0].assertCurrent, /retired/)
  await f.ctx.tool.reload()
  const latest = (await f.ctx.tool.list())[0]
  assert.equal(latest.options, f.originals[0].options)
  assert.equal(await latest.execute({}, toolContext()), f.result)
  assert.throws(f.fences[1].assertCurrent, /retired/)
  f.revoke()
  await assert.rejects(f.captured[0].execute({}, toolContext()), /revoked/)
})
