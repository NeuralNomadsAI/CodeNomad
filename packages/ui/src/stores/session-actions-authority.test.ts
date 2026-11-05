import assert from "node:assert/strict"
import { after, afterEach, before, test } from "node:test"
import { serverApi } from "../lib/api-client"
import { sdkManager } from "../lib/sdk-manager"
import type { Session } from "../types/session"
import { addInstance, instances, removeInstance, updateInstance } from "./instances"
import { messageStoreBus } from "./message-v2/bus"
import { destroyOpenCodeData } from "./opencode-data"
import { executeCustomCommand, renameSession, runShellCommand, sendMessage, updateSessionAgent, updateSessionModel } from "./session-actions"
import { createSession, fetchAgents, fetchProviders, forkSession, refreshSessionCatalog } from "./session-api"
import { fetchCommands, getCommands } from "./commands"
import { getDefaultModel } from "./session-models"
import { agents, providers, sessions, setAgents, setProviders, setSessions, getSessionNextCursor, setSessionPage } from "./session-state"
import { createRoot } from "solid-js"
import { usePromptPicker } from "../components/prompt-input/usePromptPicker"
import { getAttachments } from "./attachments"
import toast from "solid-toast"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const originals = { fetchConfigOwner: serverApi.fetchConfigOwner, fetchStateOwner: serverApi.fetchStateOwner, patchStateOwner: serverApi.patchStateOwner }
const originalToast = toast.custom
before(() => {
  toast.custom = () => "action-authority-notice"
  serverApi.fetchConfigOwner = async () => ({}) as any
  serverApi.fetchStateOwner = async () => ({}) as any
  serverApi.patchStateOwner = async (_owner, patch) => patch as any
})
after(() => { Object.assign(serverApi, originals); toast.custom = originalToast })
const ids = new Set<string>()
afterEach(() => {
  for (const id of ids) {
    removeInstance(id, { authoritative: false })
    sdkManager.destroyClientsForInstance(id)
    messageStoreBus.unregisterInstance(id)
  }
  ids.clear()
  setSessions(new Map())
  setAgents(new Map())
  setProviders(new Map())
})
function seed(id = "A", serverId = id) {
  ids.add(id)
  const calls: { method: string; input: any; options?: any }[] = []
  const call = (method: string) => async (input: any, options?: any) => { calls.push({ method, input, options }); return { id: input.id } }
  const client: any = { session: {
    instructions: { entry: { put: call("put"), remove: call("remove") } },
    switchAgent: call("agent"), switchModel: call("model"), prompt: call("prompt"),
    command: call("command"), shell: call("shell"), update: call("rename"),
    create: async () => ({ id: "created", location: { directory: "/same/" }, time: { created: 1 } }),
    fork: async () => ({ id: "fork", location: { directory: "/same/" }, time: { created: 1 } }),
  } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/same/", client, status: "ready", proxyPath: "", pid: 0, port: 0,
    binding: { serverId, directory: "/same/" }, capabilities: { generation: 1 } as any })
  setSessions(previous => new Map(previous).set(id, new Map([["session", {
    id: "session", instanceId: id, title: "original", agent: "build", model: { providerId: "p", modelId: "m" },
    parentId: null, status: "idle", location: { directory: "/same/" }, time: { created: 1, updated: 1 },
  } as Session]])))
  setAgents(previous => new Map(previous).set(id, [{ id: "plan", name: "Plan", description: "", mode: "primary", model: { providerId: "p", modelId: "m" } }]))
  setProviders(previous => new Map(previous).set(id, [{ id: "p", name: "p", models: [{ id: "m", providerId: "p", name: "m" }] }]))
  return { client, calls }
}
function retire(kind: string, id = "A") {
  if (kind === "rotation") updateInstance(id, { capabilities: { generation: 2 } as any })
  else if (kind === "rebind") updateInstance(id, { binding: { serverId: "B", directory: "/same/" } })
  else if (kind === "close") removeInstance(id, { authoritative: false })
  else destroyOpenCodeData(id)
}

for (const method of ["prompt", "command", "shell"] as const) {
  for (const kind of ["rotation", "rebind", "close", "native-generation"]) {
    test(`${method} captures its authority before waiting in admission (${kind})`, async () => {
      const { client, calls } = seed()
      const gate = deferred()
      client.session.instructions.entry.put = async () => gate.promise
      const first = sendMessage("A", "session", "first")
      const firstRejected = assert.rejects(first, /superseded|not ready/i)
      await tick()
      const second = method === "prompt" ? sendMessage("A", "session", "queued", [], { delivery: "queue" })
        : method === "command" ? executeCustomCommand("A", "session", "review", "args") : runShellCommand("A", "session", "pwd")
      const secondRejected = assert.rejects(second, /superseded|not ready/i)
      retire(kind)
      gate.resolve()
      await Promise.all([firstRejected, secondRejected])
      assert.equal(calls.filter(call => ["prompt", "command", "shell", "agent", "model"].includes(call.method)).length, 0)
    })
  }
}
for (const stage of ["voice", "placement", "agent", "model", "prompt"] as const) {
  test(`prompt rechecks after awaited ${stage} without publication or replay`, async () => {
    const { client, calls } = seed()
    const gate = deferred()
    const entry = client.session.instructions.entry
    if (stage === "voice") entry.remove = () => gate.promise
    else if (stage === "placement") entry.put = () => gate.promise
    else client.session[stage === "agent" ? "switchAgent" : stage === "model" ? "switchModel" : "prompt"] = async (input: any) => {
      calls.push({ method: stage, input }); await gate.promise; return { id: "confirmed" }
    }
    const sending = sendMessage("A", "session", "keep draft")
    const rejected = assert.rejects(sending, /superseded/i)
    await tick()
    retire("rotation")
    const replacement = { ...sessions().get("A")!.get("session")!, title: "new occurrence", generationRecovery: null }
    setSessions(new Map([["A", new Map([["session", replacement]])]]))
    gate.resolve()
    await rejected
    assert.equal(sessions().get("A")!.get("session"), replacement)
    assert.equal(messageStoreBus.getOrCreate("A").getMessage("confirmed"), undefined)
    assert.equal(calls.filter(call => call.method === "prompt").length, stage === "prompt" ? 1 : 0)
  })
}
test("local and explicit same IDs send only on each captured target, restoring queued skill/agent payloads", async () => {
  for (const id of ["local-shared", "A", "B"]) {
    const { calls } = seed(id)
    await sendMessage(id, "session", "hello", [], { delivery: "queue", restoredPayload: { text: "hello", agents: [], skills: [] } as any })
    await executeCustomCommand(id, "session", "review", "args")
    await runShellCommand(id, "session", "pwd")
    assert.deepEqual(calls.filter(call => ["prompt", "command", "shell"].includes(call.method)).map(call => call.method), ["prompt", "command", "shell"])
    for (const call of calls) assert.deepEqual(call.options, id === "local-shared" ? undefined
      : { headers: { "x-codenomad-connection-generation": "1" } })
    const placement = calls.find(call => call.input.key === "codenomad.session-placement")!.input.value
    if (id !== "local-shared") {
      assert.match(placement, /execution boundary/i)
      assert.doesNotMatch(placement, /opened local repository|default worktree parent|\.codenomad\/worktrees/)
    } else assert.match(placement, /opened local repository/)
  }
})
test("ambiguous prompt failure is never retried", async () => {
  const { client, calls } = seed()
  client.session.prompt = async () => { calls.push({ method: "prompt", input: {} }); throw new Error("acknowledgement lost") }
  await assert.rejects(sendMessage("A", "session", "recover me"), /acknowledgement lost/)
  await tick()
  assert.equal(calls.filter(call => call.method === "prompt").length, 1)
  assert.equal(sessions().get("A")!.get("session")!.generationRecovery, undefined)
})
for (const action of ["agent", "model", "rename"]) {
  test(`${action} ignores late acknowledgement after same-client rotation`, async () => {
    const { client } = seed()
    const gate = deferred()
    client.session[action === "agent" ? "switchAgent" : action === "model" ? "switchModel" : "update"] = () => gate.promise
    const request = action === "agent" ? updateSessionAgent("A", "session", "plan") : action === "model"
      ? updateSessionModel("A", "session", { providerId: "p", modelId: "m" }) : renameSession("A", "session", "late")
    const rejected = assert.rejects(request, /superseded/i)
    await tick()
    retire("rotation")
    const replacement = { ...sessions().get("A")!.get("session")!, title: "new", model: { providerId: "p", modelId: "new" } }
    setSessions(new Map([["A", new Map([["session", replacement]])]]))
    gate.resolve()
    await rejected
    assert.equal(sessions().get("A")!.get("session"), replacement)
  })
}
test("default model read cannot return another binding's same-ID catalog after preferences await", async () => {
  seed()
  setAgents(new Map([["A", [{ id: "plan", name: "Plan", description: "", mode: "primary" }]]]))
  const request = getDefaultModel("A", "plan")
  const rejected = assert.rejects(request, /superseded/i)
  retire("rebind")
  await rejected
})
test("default model HTTP fallback retains the exact captured directory and generation", async () => {
  const { client } = seed()
  setProviders(new Map())
  const gate = deferred<any>()
  client.model = { default: (input: any) => { assert.deepEqual(input.location, { directory: "/same/" }); return gate.promise } }
  const request = getDefaultModel("A")
  const rejected = assert.rejects(request, /superseded/i)
  retire("rotation")
  gate.resolve({ data: { providerID: "p", id: "m" } })
  await rejected
})
for (const operation of ["create", "fork"] as const) {
  test(`${operation} rejects returned foreign Location before publishing`, async () => {
    const { client } = seed()
    client.session[operation] = async () => ({ id: "foreign", location: { directory: "/same/child" }, time: { created: 1 } })
    await assert.rejects(operation === "create" ? createSession("A") : forkSession("A", "session"), /location|scope/i)
    assert.equal(sessions().get("A")!.has("foreign"), false)
  })
}
test("agent catalog stops dependent built-in lookups after rotation", async () => {
  const { client } = seed()
  const gate = deferred<any>()
  let dependent = 0
  client.agent = { list: () => gate.promise, get: async () => { dependent++; return { data: { id: "build" } } } }
  const request = fetchAgents("A", { directory: "/same/" })
  retire("rotation")
  gate.resolve({ data: [] })
  assert.equal(await request, false)
  assert.equal(dependent, 0)
  assert.equal(agents().get("A")![0].id, "plan")
})
test("native commands discard late same-client rotation results", async () => {
  const { client } = seed()
  const gate = deferred<any>()
  client.command = { list: () => gate.promise }
  const request = fetchCommands("A", client, { directory: "/same/" })
  retire("rotation")
  gate.resolve({ data: [{ name: "stale" }] })
  assert.equal(await request, false)
  assert.deepEqual(getCommands("A"), [])
})

for (const operation of ["create", "fork"] as const) {
  test(`${operation} discards a late acknowledgement without publishing on a replacement generation`, async () => {
    const { client } = seed()
    const gate = deferred<any>()
    client.session[operation] = () => gate.promise
    const request = operation === "create" ? createSession("A") : forkSession("A", "session")
    const rejected = assert.rejects(request, /superseded/i)
    await tick()
    retire("rotation")
    gate.resolve({ id: "late", location: { directory: "/same/" }, time: { created: 1 } })
    await rejected
    assert.equal(sessions().get("A")!.has("late"), false)
  })
}
test("creation captures authority before default-model await and never dispatches after rebind", async () => {
  const { client } = seed()
  let creates = 0
  client.session.create = async () => { creates++; throw new Error("must not dispatch") }
  const request = createSession("A")
  const rejected = assert.rejects(request, /superseded/i)
  retire("rebind")
  await rejected
  assert.equal(creates, 0)
})
test("provider rotation preserves the displayed catalogue and inventory cursor while rejecting stale publication", async () => {
  const { client } = seed()
  const original = providers().get("A")
  setSessionPage("A", ["session"], true, true, "opaque-cursor")
  const gate = deferred<any>()
  client.provider = { list: () => gate.promise }
  client.model = { list: async () => ({ data: [] }), default: async () => ({ data: null }) }
  const request = fetchProviders("A", { directory: "/same/" })
  retire("rotation")
  gate.resolve({ data: [] })
  assert.equal(await request, false)
  assert.equal(providers().get("A"), original)
  assert.equal(getSessionNextCursor("A"), "opaque-cursor")
})
test("explicit placement and prompt omit host environment and local worktree claims", async () => {
  const { calls } = seed()
  updateInstance("A", { environmentVariables: { HOME: "HOST_ENV_SENTINEL", PATH: "HOST_PATH_SENTINEL" } })
  await sendMessage("A", "session", "native tools only")
  const text = JSON.stringify(calls)
  assert.doesNotMatch(text, /HOST_ENV_SENTINEL|HOST_PATH_SENTINEL|default worktree parent|opened local repository/)
  assert.match(text, /execution boundary/)
  assert.match(text, /native session environment/)
})
test("explicit file-reference admission rejects direct and restored URI references before instructions", async () => {
  const { calls } = seed()
  const attachment = { id: "file", type: "file", url: "file:///same/notes", filename: "notes", mediaType: "text/plain", display: "@notes",
    source: { type: "file", path: "/same/notes", mime: "text/plain" } } as any
  for (const restoredPayload of [undefined, { text: "@notes", files: [{ source: { type: "uri", uri: attachment.url }, mime: "text/plain" }] } as any]) {
    await assert.rejects(sendMessage("A", "session", "@notes", [attachment], { restoredPayload }), /Project file references/)
  }
  assert.deepEqual(calls, [])
})
test("explicit file handler rejects root/file selection through every key and click without changing the draft", () => {
  seed()
  createRoot(dispose => {
    try {
      let prompt = "@./"
      const picker = usePromptPicker({ instanceId: () => "A", sessionId: () => "session", instanceFolder: () => "/same/",
        prompt: () => prompt, setPrompt: value => { prompt = value }, getTextarea: () => null, instanceAgents: () => [], commands: () => [] })
      for (const action of ["tab", "enter", "shiftEnter", "click"] as const) {
        for (const path of [".", "notes.txt"]) picker.handlePickerSelect({ type: "file", file: { path, relativePath: path, isGitFile: false, isDirectory: path === "." } }, action)
      }
      assert.equal(prompt, "@./")
      assert.deepEqual(getAttachments("A", "session"), [])
    } finally { dispose() }
  })
})

test("a first native connection refreshes a demanded catalogue only on the same durable target", async () => {
  const { client } = seed()
  const gate = deferred<any>()
  let reads = 0
  const rows = (label: string) => ({ data: ["build", "plan"].map(id => ({ id, name: `${id}-${label}`, mode: "primary" })) })
  client.agent = { list: () => ++reads === 1 ? gate.promise : Promise.resolve(rows("fresh")) }
  client.provider = { list: async () => ({ data: [] }) }
  client.model = { list: async () => ({ data: [] }), default: async () => ({ data: null }) }
  client.command = { list: async () => ({ data: [] }) }
  const request = refreshSessionCatalog("A", true)
  await tick()
  assert.equal(reads, 1)
  destroyOpenCodeData("A")
  gate.resolve(rows("stale"))
  await request
  assert.equal(reads, 2)
  assert.equal(agents().get("A")![0].name, "build-fresh")
})
