import assert from "node:assert/strict"
import { it } from "node:test"
import { createRoot } from "solid-js"
import { sdkManager } from "../lib/sdk-manager"
import { serverApi } from "../lib/api-client"
import { backgroundReads } from "../lib/background-read-queue"
import { addInstance, handleInstanceInvalidation, removeInstance, updateInstance } from "./instances"
import { loadMessages, loadLatestMessageWindow, loadOldestMessageWindow, loadMoreMessages, loadNewerMessageWindow, loadMessageAnchor } from "./session-api"
import { getSessionMessagesLoadError, sessions, setActiveSession, setSessions } from "./session-state"
import { messageStoreBus } from "./message-v2/bus"
import { applyOpenCodeDataEvent, destroyOpenCodeData } from "./opencode-data"
import { historyWindowCursor, readHistoryWindow } from "./history-window"
import { findHistoryMatches, findRankedHistoryMatches, executeSessionTechnicalPartDeletion } from "./session-history"
import { deleteMessageTechnicalParts } from "./session-actions"
import { UnavailableHistoryAnchorError } from "./session-history-capability"
import { createSessionOutline } from "./session-outline"
import { createTimelinePreviews } from "./timeline-previews"
import { acquirePermissionReceipts } from "./permission-receipt-cache"
import type { Session } from "../types/session"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const id = (index: number) => `msg_${String(index).padStart(4, "0")}`
const model = { providerID: "p", id: "m" }
const message = (index: number, source = "A") => ({ id: id(index), type: "assistant", agent: "build", model,
  time: { created: index + 1, completed: index + 2 }, content: [{ type: "text", text: `${source} ${index}` }] })

function fixture(owner: string, serverId = "A") {
  const calls: any[] = [], cursors = new Map<string, { order: "asc" | "desc"; start: number }>()
  let custom: ((input: any, options: { signal?: AbortSignal }) => Promise<any>) | undefined
  const page = (input: any) => {
    const { order, start } = input.cursor ? cursors.get(input.cursor)! : { order: input.order ?? "desc", start: 0 }
    assert.ok(order, "UI forwards an opaque token unchanged")
    const indexes = Array.from({ length: 451 }, (_, i) => order === "asc" ? i : 450 - i)
    const rows = indexes.slice(start, start + (input.limit ?? 200))
    if (!rows.length) return { data: [], cursor: {} }
    const cursor = (next: number, direction: string) => {
      const token = `${order}:${next}:${direction}:${start}`
      cursors.set(token, { order, start: next })
      return token
    }
    return { data: rows.map(i => message(i, serverId)), cursor: {
      previous: cursor(Math.max(0, start - 200), "previous"), next: cursor(start + rows.length, "next"),
    } }
  }
  const client: any = { session: { active: async () => ({}), message: { get: async () => { throw new Error("Enriched message read forbidden") } } },
    message: { list: async (input: any, options: { signal?: AbortSignal } = {}) => {
      assert.ok(!input.cursor || !input.order, "native order and cursor are exclusive")
      assert.ok(!input.cursor?.startsWith("codenomad:"))
      calls.push(input)
      return custom ? custom(input, options) : page(input)
    } } }
  ;(sdkManager as any).clients.set(`${owner}:/workspaces/${owner}/instance`, client)
  addInstance({ id: owner, binding: { serverId, directory: "/Work/" }, folder: "/Work/", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions(previous => new Map(previous).set(owner, new Map([["s", {
    id: "s", instanceId: owner, parentId: null, title: "s", agent: "build", model: { providerId: "p", modelId: "m" },
    status: "idle", runtimeStatusKnown: true, projectID: "same", location: { directory: "/Work/" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  } as Session]])))
  const store = messageStoreBus.getOrCreate(owner)
  const text = (key: string) => Object.values(store.getMessage(key)?.parts ?? {}).map((p: any) => p.data.text ?? "").join("")
  return { owner, client, calls, page, store, text, read: (read?: typeof custom) => { custom = read }, cleanup() {
    destroyOpenCodeData(owner); messageStoreBus.unregisterInstance(owner)
    setSessions(previous => { const next = new Map(previous); next.delete(owner); return next })
    removeInstance(owner, { authoritative: false }); sdkManager.destroyClientsForInstance(owner)
  } }
}

it("native latest/oldest/older/newer use one bounded page and the previous/next token in its originating order", async () => {
  const f = fixture("native-directions")
  try {
    await loadMessages(f.owner, "s")
    assert.deepEqual(f.calls[0], { sessionID: "s", limit: 200, order: "desc" })
    assert.deepEqual(f.store.getSessionMessageIds("s"), Array.from({ length: 200 }, (_, i) => id(251 + i)))
    await loadMoreMessages(f.owner, "s")
    assert.deepEqual(f.calls.at(-1), { sessionID: "s", limit: 200, cursor: "desc:200:next:0" })
    assert.equal(f.store.getSessionMessageIds("s")[0], id(51))
    await loadNewerMessageWindow(f.owner, "s")
    assert.equal(f.calls.at(-1).cursor, "desc:0:previous:200")
    assert.equal(f.store.getSessionMessageIds("s")[0], id(251))
    await loadOldestMessageWindow(f.owner, "s")
    assert.deepEqual(f.calls.at(-1), { sessionID: "s", limit: 200, order: "asc" })
    assert.equal(f.store.getSessionMessageIds("s")[0], id(0))
    await loadNewerMessageWindow(f.owner, "s")
    assert.equal(f.calls.at(-1).cursor, "asc:200:next:0")
    assert.equal(f.store.getSessionMessageIds("s")[0], id(200))
    await loadMoreMessages(f.owner, "s")
    assert.equal(f.calls.at(-1).cursor, "asc:0:previous:200")
    assert.equal(f.store.getSessionMessageIds("s")[0], id(0))
    assert.equal(f.calls.length, 6)
  } finally { f.cleanup() }
})

for (const honorsAbort of [false, true]) for (const intent of ["latest", "older"] as const) it(`fresh ${intent} demand after resident supersession owns a new read (honorsAbort=${honorsAbort})`, async () => {
  const f = fixture(`native-supersession-${intent}-${honorsAbort}`), hold = deferred<any>()
  const load = intent === "latest" ? loadLatestMessageWindow : loadMoreMessages
  let old: Promise<boolean> | undefined, fresh: Promise<boolean> | undefined
  try {
    await loadMessages(f.owner, "s")
    f.read(async (input, { signal }) => {
      if (f.calls.length !== 2) return f.page(input)
      if (!honorsAbort) return hold.promise
      return new Promise((resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
        hold.promise.then(resolve, reject)
      })
    })
    old = load(f.owner, "s")
    await tick()
    assert.equal(f.calls.length, 2)
    assert.equal(await loadMessageAnchor(f.owner, "s", id(450)), true)
    fresh = load(f.owner, "s")
    await tick()
    assert.equal(f.calls.length, 3, "the cancelled epoch cannot absorb a new consumer")
    assert.equal(await fresh, true)
  } finally { hold.resolve({ data: [], cursor: {} }); await Promise.allSettled([old, fresh]); f.cleanup() }
})

function emitAssistant(owner: string, index: number) {
  for (const [ordinal, [type, data]] of ([
    ["session.step.started", { assistantMessageID: id(index), agent: "build", model }],
    ["session.text.started", { assistantMessageID: id(index) }],
    ["session.text.delta", { assistantMessageID: id(index), ordinal: 0, delta: "LIVE" }],
  ] as const).entries()) handleInstanceInvalidation(owner, { id: `event-${index}-${ordinal}`, type, created: ordinal + 1,
    location: { directory: "/Work/" }, data: { sessionID: "s", ...data } } as any)
}

for (const scenario of ["initial", "reload"] as const) it(`${scenario} merges live arrivals after its dependent model read`, async () => {
  const f = fixture(`native-model-await-${scenario}`), modelRead = deferred<any>()
  let reads = 0, pending: Promise<boolean> | undefined
  try {
    setActiveSession(f.owner, "s")
    f.read(async () => ({ data: [{ id: id(1), type: "user", text: "Resident", time: { created: 1 } }], cursor: {} }))
    if (scenario === "reload") await loadMessages(f.owner, "s")
    setSessions(previous => {
      const next = new Map(previous), rows = new Map(next.get(f.owner)!)
      rows.set("s", { ...rows.get("s")!, model: { providerId: "", modelId: "" } })
      return next.set(f.owner, rows)
    })
    f.client.model = { default: () => { reads++; return modelRead.promise } }
    pending = loadLatestMessageWindow(f.owner, "s")
    await tick()
    assert.equal(reads, 1)
    emitAssistant(f.owner, 2)
    assert.ok(f.store.getSessionMessageIds("s").includes(id(2)))
    modelRead.resolve({ data: model })
    assert.equal(await pending, true)
    assert.deepEqual(f.store.getSessionMessageIds("s"), [id(1), id(2)])
    assert.equal(f.text(id(2)), "LIVE")
  } finally { modelRead.resolve({ data: model }); await Promise.allSettled([pending]); f.cleanup() }
})

// prototype-1236 (R7): the empty reply is retried, then the resident passage is kept without an error state.
it("a raw empty latest response beside new live rows neither fails nor replaces the reading passage", async () => {
  const f = fixture("native-empty-latest-live"), hold = deferred<any>()
  let pending: Promise<boolean> | undefined
  try {
    setActiveSession(f.owner, "s")
    await loadMessages(f.owner, "s")
    f.store.setScrollSnapshot("s", "message-stream", { atBottom: false, scrollTop: 42, anchorKey: id(400), anchorOffset: 7 })
    const snapshot = f.store.getScrollSnapshot("s", "message-stream"), window = f.store.getMessageWindow("s")
    f.read(() => hold.promise)
    pending = loadLatestMessageWindow(f.owner, "s")
    await tick()
    emitAssistant(f.owner, 451)
    assert.ok(f.store.getSessionMessageIds("s").includes(id(400)))
    hold.resolve({ data: [], cursor: {} })
    assert.equal(await pending, false)
    assert.ok(!getSessionMessagesLoadError(f.owner, "s"))
    assert.ok(f.store.getSessionMessageIds("s").includes(id(400)))
    assert.equal(f.text(id(451)), "LIVE")
    assert.equal(f.store.getScrollSnapshot("s", "message-stream"), snapshot)
    assert.equal(f.store.getMessageWindow("s"), window)
  } finally { hold.resolve({ data: [], cursor: {} }); await Promise.allSettled([pending]); f.cleanup() }
})

it("homonymous local/A/B transcript IDs and tokens retain separate owners", async () => {
  const all = [fixture("native-local", "local-shared"), fixture("native-A", "A"), fixture("native-B", "B")]
  try {
    await Promise.all(all.map(f => loadMessages(f.owner, "s")))
    await Promise.all(all.map(f => loadMoreMessages(f.owner, "s")))
    for (const [i, f] of all.entries()) assert.equal(f.text(id(51)), `${["local-shared", "A", "B"][i]} 51`)
  } finally { all.forEach(f => f.cleanup()) }
})

for (const intent of ["older", "newer"] as const) it(`${intent} failure/timeout/empty preserve resident rows, window and saved anchor`, async () => {
  const f = fixture(`native-failure-${intent}`)
  try {
    await loadMessages(f.owner, "s")
    if (intent === "newer") await loadOldestMessageWindow(f.owner, "s")
    f.store.setScrollSnapshot("s", "message-stream", { scrollTop: 42, atBottom: false, anchorKey: f.store.getSessionMessageIds("s")[10], anchorOffset: 7 })
    const before = f.store.getSessionMessageIds("s"), window = f.store.getMessageWindow("s"), snapshot = f.store.getScrollSnapshot("s", "message-stream")
    const load = intent === "older" ? loadMoreMessages : loadNewerMessageWindow
    for (const reason of [new Error("offline"), new DOMException("timeout", "TimeoutError")]) {
      f.read(async () => { throw reason })
      await assert.rejects(load(f.owner, "s"))
      assert.deepEqual(f.store.getSessionMessageIds("s"), before)
      assert.equal(f.store.getMessageWindow("s"), window)
      assert.equal(f.store.getScrollSnapshot("s", "message-stream"), snapshot)
    }
    f.read(async () => ({ data: [], cursor: {} }))
    await load(f.owner, "s")
    assert.deepEqual(f.store.getSessionMessageIds("s"), before)
    assert.equal(f.store.getScrollSnapshot("s", "message-stream")?.anchorKey, snapshot?.anchorKey)
    // prototype-1236 (R7): an empty newer reply means the resident page is the latest one.
    assert.equal(f.store.getMessageWindow("s")?.kind, intent === "newer" ? "latest" : window?.kind)
    assert.ok(!getSessionMessagesLoadError(f.owner, "s"))
  } finally { f.cleanup() }
})

it("cold restoration and nonresident anchors refuse before RPC/native dispatch; resident navigation supersedes a pending page", async () => {
  const f = fixture("native-anchor")
  const original = serverApi.fetchHistoryWindow
  let enriched = 0
  serverApi.fetchHistoryWindow = async () => { enriched++; throw new Error("Forbidden RPC") }
  try {
    const snapshot = { scrollTop: 42, atBottom: false, anchorKey: "not-loaded", windowIsLatest: false,
      windowCursor: historyWindowCursor({ kind: "around", messageID: "not-loaded" }) }
    f.store.setScrollSnapshot("s", "message-stream", snapshot)
    await assert.rejects(loadMessages(f.owner, "s"), UnavailableHistoryAnchorError)
    assert.equal(f.calls.length, 0)
    assert.equal(f.store.getScrollSnapshot("s", "message-stream")?.anchorKey, "not-loaded")
    assert.ok(getSessionMessagesLoadError(f.owner, "s"))
    await loadLatestMessageWindow(f.owner, "s")
    const saved = f.store.getScrollSnapshot("s", "message-stream")
    await assert.rejects(loadMessageAnchor(f.owner, "s", "elsewhere"), UnavailableHistoryAnchorError)
    assert.equal(f.calls.length, 1)
    assert.equal(f.store.getScrollSnapshot("s", "message-stream"), saved)
    const hold = deferred<any>()
    f.read(() => hold.promise)
    const pending = loadOldestMessageWindow(f.owner, "s")
    await tick()
    assert.equal(await loadMessageAnchor(f.owner, "s", id(450)), true)
    hold.resolve(f.page({ order: "asc", limit: 200 }))
    assert.equal(await pending, false)
    assert.equal(f.store.getSessionMessageIds("s").at(-1), id(450))
    assert.equal(enriched, 0)
  } finally { serverApi.fetchHistoryWindow = original; f.cleanup() }
})

for (const change of ["native", "connection", "rebind", "close", "cancel"] as const) it(`fences ${change} before queued dispatch and after await`, async () => {
  for (const queued of [true, false]) {
    const f = fixture(`native-fence-${change}-${queued}`), controller = new AbortController()
    const slots = [deferred<void>(), deferred<void>()]
    const held = queued ? slots.map(slot => backgroundReads.run(new AbortController().signal, () => slot.promise)) : []
    const response = deferred<any>()
    f.read(() => response.promise)
    const changeOwner = () => {
      if (change === "native") destroyOpenCodeData(f.owner)
      if (change === "connection") updateInstance(f.owner, { capabilities: { generation: 2 } as any })
      if (change === "rebind") updateInstance(f.owner, { binding: { serverId: "B", directory: "/Work/" } })
      if (change === "close") removeInstance(f.owner, { authoritative: false })
      if (change === "cancel") controller.abort()
    }
    try {
      const request = loadLatestMessageWindow(f.owner, "s", controller.signal)
      await tick()
      changeOwner()
      slots.forEach(slot => slot.resolve())
      await Promise.all(held)
      response.resolve(f.page({ order: "desc", limit: 200 }))
      assert.equal(await request, false)
      assert.equal(f.calls.length, queued ? 0 : 1)
      assert.equal(f.store.getSessionMessageIds("s").length, 0)
    } finally { slots.forEach(slot => slot.resolve()); response.resolve({ data: [], cursor: {} }); await Promise.allSettled(held); f.cleanup() }
  }
})

it("pre-aborted navigation dispatches nothing and connection replacement cannot reuse retained native cursors", async () => {
  const f = fixture("native-cursor-owner")
  try {
    const cancelled = new AbortController(); cancelled.abort()
    assert.equal(await loadLatestMessageWindow(f.owner, "s", cancelled.signal), false)
    assert.equal(f.calls.length, 0)
    await loadMessages(f.owner, "s")
    updateInstance(f.owner, { capabilities: { generation: 2 } as any })
    await assert.rejects(loadMoreMessages(f.owner, "s"), UnavailableHistoryAnchorError)
    assert.equal(f.calls.length, 1)
    await loadLatestMessageWindow(f.owner, "s")
    await loadMoreMessages(f.owner, "s")
    assert.equal(f.calls.length, 3)
  } finally { f.cleanup() }
})

it("reload merges native text and new messages arriving during the page without retrying or rewinding live content", async () => {
  const f = fixture("native-live-merge")
  let sequence = 0
  const emit = (type: string, data: any) => applyOpenCodeDataEvent(f.owner, "/Work/", {
    id: `event-${++sequence}`, type, created: sequence, location: { directory: "/Work/" }, data: { sessionID: "s", ...data },
  } as any)
  try {
    emit("session.step.started", { assistantMessageID: id(450), agent: "build", model })
    emit("session.text.started", { assistantMessageID: id(450) })
    emit("session.text.delta", { assistantMessageID: id(450), ordinal: 0, delta: "LIVE" })
    const hold = deferred<any>()
    f.read(() => hold.promise)
    const pending = loadLatestMessageWindow(f.owner, "s")
    await tick()
    emit("session.text.delta", { assistantMessageID: id(450), ordinal: 0, delta: "+DELTA" })
    emit("session.step.started", { assistantMessageID: id(451), agent: "build", model })
    emit("session.text.started", { assistantMessageID: id(451) })
    emit("session.text.delta", { assistantMessageID: id(451), ordinal: 0, delta: "NEW" })
    hold.resolve(f.page({ order: "desc", limit: 200 }))
    assert.equal(await pending, true)
    assert.equal(f.calls.length, 1)
    assert.equal(f.text(id(450)), "LIVE+DELTA")
    assert.equal(f.text(id(451)), "NEW")
    assert.equal(f.store.getSessionMessageIds("s").length, 200)
  } finally { f.cleanup() }
})

it("an empty older boundary preserves the live append and reading anchor", async () => {
  const f = fixture("native-empty-live")
  try {
    setActiveSession(f.owner, "s")
    await loadMessages(f.owner, "s")
    f.store.setScrollSnapshot("s", "message-stream", { scrollTop: 24, atBottom: false, anchorKey: id(400), anchorOffset: 7 })
    const hold = deferred<any>()
    f.read(() => hold.promise)
    const pending = loadMoreMessages(f.owner, "s")
    await tick()
    for (const [index, [type, data]] of ([
      ["session.step.started", { assistantMessageID: id(451), agent: "build", model }],
      ["session.text.started", { assistantMessageID: id(451) }],
      ["session.text.delta", { assistantMessageID: id(451), ordinal: 0, delta: "LIVE" }],
    ] as const).entries()) handleInstanceInvalidation(f.owner, { id: `event-${index}`, type, created: index + 1,
      location: { directory: "/Work/" }, data: { sessionID: "s", ...data } } as any)
    hold.resolve({ data: [], cursor: {} })
    await pending
    assert.equal(f.text(id(451)), "LIVE")
    assert.equal(f.store.getMessageWindow("s")?.kind, "latest")
    assert.equal(f.store.getScrollSnapshot("s", "message-stream")?.anchorKey, id(400))
    assert.equal(f.store.getScrollSnapshot("s", "message-stream")?.anchorOffset, 7)
  } finally { f.cleanup() }
})

it("same native page consumers share their read and one cancelled consumer cannot revoke the other", async () => {
  const f = fixture("native-shared-consumers")
  const hold = deferred<any>(), controller = new AbortController()
  try {
    await loadMessages(f.owner, "s")
    f.read(() => hold.promise)
    const first = loadMoreMessages(f.owner, "s", controller.signal)
    const second = loadMoreMessages(f.owner, "s")
    await tick()
    controller.abort()
    assert.equal(await first, false)
    hold.resolve(f.page({ cursor: "desc:200:next:0", limit: 200 }))
    assert.equal(await second, true)
    assert.equal(f.calls.length, 2)
    assert.equal(f.store.getSessionMessageIds("s")[0], id(51))
  } finally { hold.resolve({ data: [], cursor: {} }); f.cleanup() }
})

it("direct enriched search/window/pruning handlers reject before reads and metadata authority is kept", async () => {
  const f = fixture("native-enrichment-guard")
  const original = serverApi.querySessionHistory, ranked = serverApi.queryRankedHistory, prune = serverApi.pruneSessionHistory
  let reads = 0
  const forbidden = async (): Promise<any> => { reads++; throw new Error("Forbidden enrichment") }
  serverApi.querySessionHistory = forbidden; serverApi.queryRankedHistory = forbidden; serverApi.pruneSessionHistory = forbidden
  try {
    await assert.rejects(findHistoryMatches(f.owner, { query: "text", includeTechnical: false, purpose: "search", sessionID: "s" }, new AbortController().signal), /unavailable/)
    await assert.rejects(findRankedHistoryMatches(f.owner, "text", false, new AbortController().signal), /unavailable/)
    await assert.rejects(readHistoryWindow(f.owner, "s", { kind: "latest" }), /unavailable/)
    await assert.rejects(deleteMessageTechnicalParts(f.owner, "s", id(450)), /unavailable/)
    assert.throws(() => acquirePermissionReceipts(f.owner, "s", { unanchored: true }, 1), /unavailable/)
    await assert.rejects(executeSessionTechnicalPartDeletion({ instanceId: f.owner, sessionId: "s", generation: 0, candidates: [], toolCount: 0, reasoningCount: 0, skipped: 0 }), /unavailable/)
    assert.equal(reads, 0)
    assert.equal(f.calls.length, 0)
    const before = sessions().get(f.owner)!.get("s")!
    await loadMessages(f.owner, "s")
    assert.equal(sessions().get(f.owner)!.get("s")!.title, before.title)
  } finally { serverApi.querySessionHistory = original; serverApi.queryRankedHistory = ranked; serverApi.pruneSessionHistory = prune; f.cleanup() }
})

it("direct structural outline and timeline-preview demand stay closed for an explicit binding", async () => {
  const f = fixture("native-outline-preview-guard")
  const outlineRead = serverApi.fetchSessionOutline, previewRead = serverApi.fetchOutlinePreviews
  let reads = 0, dispose!: () => void
  serverApi.fetchSessionOutline = async () => { reads++; throw new Error("Forbidden outline") }
  serverApi.fetchOutlinePreviews = async () => { reads++; throw new Error("Forbidden preview") }
  try {
    const { outline, preview } = createRoot(stop => {
      dispose = stop
      return { outline: createSessionOutline({ instanceId: () => f.owner, sessionId: () => "s", active: () => true }),
        preview: createTimelinePreviews({ instanceId: () => f.owner, sessionId: () => "s", active: () => true, requested: () => [id(0)] }) }
    })
    await tick()
    outline.refresh()
    await tick()
    assert.deepEqual(outline.entries(), [])
    assert.equal(preview(id(0)), undefined)
    assert.equal(reads, 0)
  } finally { dispose?.(); serverApi.fetchSessionOutline = outlineRead; serverApi.fetchOutlinePreviews = previewRead; f.cleanup() }
})
