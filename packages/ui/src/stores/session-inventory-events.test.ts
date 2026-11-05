import assert from "node:assert/strict"
import { it } from "node:test"
import { sdkManager } from "../lib/sdk-manager"
import { serverApi } from "../lib/api-client"
import { addInstance, removeInstance, updateInstance } from "./instances"
import { handleNativeSessionEvent, handleSessionCompacted } from "./session-events"
import toast from "solid-toast"
import { getToastHistory, showToastNotification } from "../lib/notifications"
import { destroyOpenCodeData } from "./opencode-data"
import { getSessionDraftPrompt, getSessionListIds, sessions, setSessionDraftPrompt, setSessions } from "./session-state"
import { fetchSessions } from "./session-api"

const tick = () => new Promise<void>(done => setImmediate(done))
const settleMove = () => new Promise<void>(done => setTimeout(done, 160))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const capabilities = (generation: number): any => ({ generation, features: { worktrees: { state: "unavailable" } } })
const row = (id: string, directory = "/Work/") => ({ id, title: id, projectID: "same", location: { directory },
  time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
function fixture(id: string, directory = "/Work/", serverId = "A") {
  let reads = 0
  const client: any = { session: { active: async () => ({}), list: async () => {
    reads++; return { data: [row("moved", directory)], cursor: { next: "tail" } }
  } } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: directory, binding: { serverId, directory }, capabilities: capabilities(1),
    port: 0, pid: 0, proxyPath: "", status: "ready", client })
  return { id, client, reads: () => reads, cleanup() {
    removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id); destroyOpenCodeData(id)
    setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
  } }
}
function move(id: string, directory: string) {
  handleNativeSessionEvent(id, { id: "move", type: "session.moved", created: 2, location: { directory: "/Work/" },
    data: { sessionID: "moved", projectID: "same", location: { directory } } } as any)
}

it("projects an external move immediately while preserving the snapshot, draft and native parent through partial inventory", async () => {
  const f = fixture("moved-exact-partial")
  const original = serverApi.fetchWorktrees
  let worktrees = 0
  serverApi.fetchWorktrees = async () => { worktrees++; throw new Error("Host worktree lookup forbidden") }
  try {
    await fetchSessions(f.id)
    setSessions(previous => new Map(previous).set(f.id, new Map(previous.get(f.id)).set("moved", {
      ...previous.get(f.id)!.get("moved")!, parentId: "native-parent",
    })))
    setSessionDraftPrompt(f.id, "moved", "keep draft")
    f.client.session.list = async () => ({ data: [], cursor: { next: "tail-after-move" } })
    move(f.id, "/Else/")
    assert.equal(getSessionListIds(f.id).includes("moved"), false)
    assert.equal(sessions().get(f.id)?.get("moved")?.location.directory, "/Else/")
    await settleMove()
    assert.equal(getSessionListIds(f.id).includes("moved"), false)
    assert.equal(sessions().get(f.id)?.get("moved")?.parentId, "native-parent")
    assert.equal(getSessionDraftPrompt(f.id, "moved"), "keep draft")
    assert.equal(worktrees, 0)
  } finally { serverApi.fetchWorktrees = original; f.cleanup() }
})

it("invalidates only same-server exact destinations, excluding B, local and opaque path aliases", async () => {
  const a = fixture("moved-A"), target = fixture("moved-A-target", "/Target/"), b = fixture("moved-B", "/Target/", "B")
  const local = fixture("moved-local", "/Target/", "local-shared"), alias = fixture("moved-A-alias", "/target/")
  let aReads = 0, targetReads = 0, hostReads = 0
  const original = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => { hostReads++; throw new Error("Host lookup forbidden") }
  a.client.session.list = async () => { aReads++; return { data: [], cursor: { next: "a-tail" } } }
  target.client.session.list = async () => { targetReads++; return { data: [row("moved", "/Target/")], cursor: {} } }
  try {
    move(a.id, "/Target/")
    await settleMove()
    assert.equal(aReads, 1)
    assert.equal(targetReads, 1)
    assert.equal(b.reads(), 0)
    assert.equal(local.reads(), 0)
    assert.equal(alias.reads(), 0)
    assert.equal(hostReads, 0)
  } finally { serverApi.fetchWorktrees = original; [a, target, b, local, alias].forEach(f => f.cleanup()) }
})

for (const retire of ["rotation", "binding", "client", "native", "close"] as const) {
  it(`drops a cold rename result after ${retire} without publishing or inserting list IDs`, async () => {
    const f = fixture(`cold-event-${retire}`), lookup = deferred<any>()
    f.client.session.get = () => lookup.promise
    try {
      handleNativeSessionEvent(f.id, { id: "rename", type: "session.renamed", created: 2,
        location: { directory: "/Work/" }, data: { sessionID: "cold", title: "New title" } } as any)
      if (retire === "rotation") updateInstance(f.id, { capabilities: capabilities(2) })
      if (retire === "binding") updateInstance(f.id, { binding: { serverId: "B", directory: "/Work/" } })
      if (retire === "client") updateInstance(f.id, { client: {} as any })
      if (retire === "native") destroyOpenCodeData(f.id)
      if (retire === "close") removeInstance(f.id, { authoritative: false })
      lookup.resolve(row("cold"))
      await tick()
      assert.equal(sessions().get(f.id)?.has("cold") ?? false, false)
      assert.equal(getSessionListIds(f.id).includes("cold"), false)
    } finally { lookup.resolve(row("cold")); f.cleanup() }
  })
}

it("validates event Location before lookup and native identity/Location before cold publication", async () => {
  const f = fixture("cold-event-identity")
  let calls = 0
  f.client.session.get = async () => { calls++; return row("different") }
  const rename = (directory = "/Work/") => handleNativeSessionEvent(f.id, { id: "rename", type: "session.renamed", created: 2,
    location: { directory }, data: { sessionID: "cold", title: "title" } } as any)
  try {
    rename("/work/")
    await tick()
    assert.equal(calls, 0)
    rename()
    await tick()
    assert.equal(sessions().get(f.id)?.has("cold") ?? false, false)
    f.client.session.get = async () => row("cold", "/Else/")
    rename()
    await tick()
    assert.equal(sessions().get(f.id)?.has("cold") ?? false, false)
    f.client.session.get = async () => row("cold")
    rename()
    await tick()
    assert.equal(sessions().get(f.id)?.get("cold")?.location.directory, "/Work/")
  } finally { f.cleanup() }
})

it("fences delayed move refreshes when their occurrence authority retires before dispatch", async () => {
  const f = fixture("move-before-dispatch")
  try {
    move(f.id, "/Work/")
    updateInstance(f.id, { capabilities: capabilities(2) })
    await settleMove()
    assert.equal(f.reads(), 0)
  } finally { f.cleanup() }
})

for (const kind of ["retry", "compaction"] as const) {
  it(`does not announce an obsolete cold ${kind} after fresh hydration supplies the same session ID`, async t => {
    const f = fixture(`cold-announcement-${kind}`), lookup = deferred<any>()
    f.client.session.get = () => lookup.promise
    // tsx's Node package wrapper and Vite expose different default-export shapes.
    // Intercept only the display sink used by the real notification function.
    const sink = toast as any, original = sink.custom
    const bubbles = t.mock.fn(() => "fixture-only")
    sink.custom = bubbles
    t.after(() => { if (original === undefined) delete sink.custom; else sink.custom = original })
    showToastNotification({ category: "sessions", transient: true, variant: "info", message: "fixture interception check" })
    assert.equal(bubbles.mock.callCount(), 1)
    bubbles.mock.resetCalls()
    const historyBefore = getToastHistory().length
    try {
      if (kind === "retry") handleNativeSessionEvent(f.id, { id: "retry", type: "session.retry.scheduled", created: 2,
        location: { directory: "/Work/" }, data: { sessionID: "cold", attempt: 1, at: Date.now() + 1000, error: { message: "obsolete retry" } } } as any)
      else handleSessionCompacted(f.id, { id: "compact", type: "session.compaction.ended", created: 2,
        location: { directory: "/Work/" }, data: { sessionID: "cold" } } as any)
      updateInstance(f.id, { capabilities: capabilities(2) })
      f.client.session.list = async () => ({ data: [row("cold")], cursor: {} })
      await fetchSessions(f.id)
      assert.equal(sessions().get(f.id)?.has("cold"), true)
      lookup.resolve(row("cold"))
      await tick()
      assert.equal(bubbles.mock.callCount(), 0)
      assert.equal(getToastHistory().length, historyBefore)
    } finally { lookup.resolve(row("cold")); f.cleanup() }
  })
}

it("does not begin a cold terminal lookup after its preceding activity read loses connection authority", async () => {
  const f = fixture("cold-terminal-activity"), active = deferred<any>()
  let lookups = 0
  f.client.session.active = () => active.promise
  f.client.session.get = async () => { lookups++; return row("cold") }
  try {
    handleNativeSessionEvent(f.id, { id: "done", type: "session.execution.succeeded", created: 2,
      location: { directory: "/Work/" }, data: { sessionID: "cold" } } as any)
    updateInstance(f.id, { capabilities: capabilities(2) })
    active.resolve({})
    await tick()
    assert.equal(lookups, 0)
    assert.equal(sessions().get(f.id)?.has("cold") ?? false, false)
  } finally { active.resolve({}); f.cleanup() }
})
