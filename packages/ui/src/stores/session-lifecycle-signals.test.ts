import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import toast from "solid-toast"

import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"
import { tGlobal } from "../lib/i18n/index.tsx"
import { clearToastHistory, getToastHistory } from "../lib/notifications.tsx"
import { storage, type OwnerBucket } from "../lib/storage.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { preferences, updatePreferences } from "./preferences.tsx"
import { messageStoreBus } from "./message-v2/bus.ts"
import { destroyOpenCodeData } from "./opencode-data.ts"
import { clearInstanceDeletedSessionAuthority, sessions, setSessions } from "./session-state.ts"
import "./sessions.ts"

// Event sequences recorded from an isolated OpenCode 2.1.0 run
// (scripts/test-session-lifecycle-native.mjs). V2 settles a busy period with
// session.execution.* and reports provider backoff with session.retry.scheduled;
// it never publishes the deprecated session.idle/session.status declarations.
const instanceId = "lifecycle-signals"
const model = { id: "fixture", providerID: "fixture", variant: "default" }
const retryError = { type: "provider.internal", message: "fixture retry", status: 503 }
const failError = { type: "provider.invalid-request", message: "fixture fail", status: 400 }

let sequence = 0
let active: Record<string, unknown> = {}
const toasts: unknown[] = []
const dismissed: string[] = []
const originalToast = toast.custom, originalDismiss = toast.dismiss
const originalStorage = {
  loadConfigOwner: storage.loadConfigOwner, loadStateOwner: storage.loadStateOwner,
  revalidateUiConfigOwner: storage.revalidateUiConfigOwner,
  patchConfigOwner: storage.patchConfigOwner, patchStateOwner: storage.patchStateOwner,
}
let originalRouting = preferences().notificationRouting

async function enableCompletionHistory() {
  const routing = preferences().notificationRouting
  assert.equal(await updatePreferences({
    notificationRouting: { ...routing, sessionDone: { ...routing.sessionDone, history: true } },
  }), true)
}

function emit(type: string, data: Record<string, unknown>) {
  const seq = ++sequence
  ;(sseManager as any).handleEvent(instanceId, {
    id: `evt_${seq}`, type, created: seq, location: { directory: "/work" },
    durable: { aggregateID: data.sessionID, seq, version: 1 }, data,
  })
}

function run(sessionID: string, assistantMessageID: string, terminal: "succeeded" | "failed" | ["interrupted", string]) {
  emit("session.execution.started", { sessionID })
  emit("session.step.started", { sessionID, agent: "build", model, assistantMessageID, started: sequence })
  if (terminal === "succeeded") {
    const tokens = { input: 120, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }
    emit("session.step.ended", { sessionID, assistantMessageID, finish: "stop", rawFinish: "stop", cost: 0, tokens })
    emit("session.usage.updated", { sessionID, cost: 0, tokens })
    emit("session.execution.succeeded", { sessionID })
  } else if (terminal === "failed") {
    emit("session.step.failed", { sessionID, assistantMessageID, error: failError })
    emit("session.execution.failed", { sessionID, error: failError })
  } else {
    emit("session.step.failed", { sessionID, assistantMessageID, error: { type: "aborted", message: "Step interrupted" } })
    emit("session.execution.interrupted", { sessionID, reason: terminal[1] })
  }
}

const session = (id: string) => sessions().get(instanceId)?.get(id)
const doneNotifications = () => getToastHistory().filter((item) => item.message === tGlobal("sessionEvents.notify.done", { label: "Root work" }))

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.ok(check(), label)
}

/** Waits until reconciliation has settled the session, then for any trailing effects. */
async function settled(id: string) {
  await until(() => session(id)?.status === "idle", `${id} settles idle`)
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("V2 session lifecycle signals", () => {
  beforeEach(async (context) => {
    // Preferences are a singleton: load and write only fixture owner buckets,
    // and await restoration before releasing the storage/network mocks.
    originalRouting = preferences().notificationRouting
    let config: OwnerBucket = {}
    context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected fixture network request") })
    storage.loadConfigOwner = async () => ({})
    storage.loadStateOwner = async () => ({})
    storage.revalidateUiConfigOwner = async () => structuredClone(config)
    storage.patchConfigOwner = async (owner, patch) => {
      assert.equal(owner, "ui")
      config = { ...config, settings: { ...config.settings, ...(patch as OwnerBucket).settings } }
      return structuredClone(config)
    }
    storage.patchStateOwner = async () => { throw new Error("Unexpected fixture state write") }
    assert.equal(await updatePreferences({}), true)
    sequence = 0
    active = {}
    toasts.length = 0
    dismissed.length = 0
    toast.custom = ((render: unknown) => { toasts.push(render); return `toast-${toasts.length}` }) as typeof toast.custom
    toast.dismiss = ((id?: string) => { if (id) dismissed.push(id) }) as typeof toast.dismiss
    clearToastHistory()
    const client = {
      session: {
        active: async () => active,
        get: async () => { throw new Error("fixture sessions are preloaded") },
      },
      message: { list: async () => ({ data: [], cursor: {} }) },
    } as any
    ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
    addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
    const row = (id: string, parentId: string | null, title: string) => [id, {
      id, instanceId, parentId, title, agent: "build", model: { providerId: "fixture", modelId: "fixture" },
      status: "idle", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
      projectID: "project", location: { directory: "/work" }, time: { created: 1, updated: 1 },
    }] as const
    setSessions((previous) => new Map(previous).set(instanceId, new Map([
      row("root", null, "Root work"), row("child", "root", "Child work"),
    ] as any)))
  })

  afterEach(async () => {
    toast.custom = originalToast
    toast.dismiss = originalDismiss
    clearToastHistory()
    destroyOpenCodeData(instanceId)
    if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
    clearInstanceDeletedSessionAuthority(instanceId)
    removeInstance(instanceId, { authoritative: false })
    sdkManager.destroyClientsForInstance(instanceId)
    try {
      assert.equal(await updatePreferences({ notificationRouting: originalRouting }), true)
      assert.deepEqual(preferences().notificationRouting, originalRouting)
    } finally {
      Object.assign(storage, originalStorage)
    }
  })

  it("keeps completed root executions out of history by default", async () => {
    assert.equal(preferences().notificationRouting.sessionDone.history, false)
    run("root", "msg_default", "succeeded")
    await settled("root")
    assert.equal(getToastHistory().length, 0)
  })

  it("notifies once when a root session's execution succeeds, never while it is still active", async () => {
    await enableCompletionHistory()
    active = { root: {} }
    run("root", "msg_1", "succeeded")
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(session("root")?.status, "working", "a terminal event for a still-active session is stale")
    assert.equal(doneNotifications().length, 0)

    active = {}
    run("root", "msg_2", "succeeded")
    await settled("root")
    assert.equal(doneNotifications().length, 1)
    assert.equal(doneNotifications()[0].title, "work")

    // A legacy declaration must not produce a second notification for the same run.
    emit("session.idle", { sessionID: "root" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(doneNotifications().length, 1)
  })

  it("does not notify for subsessions", async () => {
    await enableCompletionHistory()
    run("child", "msg_child", "succeeded")
    await settled("child")
    assert.equal(getToastHistory().length, 0)
  })

  it("notifies when a run fails or is stopped for inactivity, not when a person stops it", async () => {
    await enableCompletionHistory()
    run("root", "msg_fail", "failed")
    await settled("root")
    assert.equal(doneNotifications().length, 1, "a failed run has ended without the user")

    run("root", "msg_user", ["interrupted", "user"])
    await settled("root")
    assert.equal(session("root")?.generationRecovery, "interrupted")
    assert.equal(doneNotifications().length, 1, "a deliberate stop needs no completion notice")

    run("root", "msg_idle", ["interrupted", "inactivity"])
    await settled("root")
    assert.equal(doneNotifications().length, 2, "OpenCode stopped an unattended run")

    // A shutdown keeps the turn's claim: it resumes after restart rather than finishing.
    run("root", "msg_shutdown", ["interrupted", "shutdown"])
    await settled("root")
    assert.equal(doneNotifications().length, 2, "a shutdown interruption is not a completion")
  })

  it("stays silent for a root session that completes before its metadata is hydrated", async () => {
    await enableCompletionHistory()
    let release!: () => void
    const hydrated = new Promise<void>((resolve) => { release = resolve })
    ;(sdkManager as any).clients.get(`${instanceId}:/workspaces/${instanceId}/instance`).session.get = async () => {
      await hydrated
      return { id: "late", title: "Late work", version: "1", projectID: "project", location: { directory: "/work" }, time: { created: 1, updated: 1 } }
    }
    run("late", "msg_late", "succeeded")
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await settled("late")
    assert.equal(session("late")?.parentId, null, "hydration reveals a root session")
    assert.equal(getToastHistory().length, 0, "an unhydrated session may be a subagent: never announce it")
  })

  it("shows native retry backoff as session retry status and a live toast that ends with its attempt", async () => {
    emit("session.execution.started", { sessionID: "root" })
    emit("session.step.started", { sessionID: "root", agent: "build", model, assistantMessageID: "msg_retry", started: 1 })
    const at = Date.now() + 5_000
    emit("session.retry.scheduled", { sessionID: "root", assistantMessageID: "msg_retry", attempt: 2, at, error: retryError })
    assert.equal(session("root")?.status, "working")
    assert.deepEqual(session("root")?.retry, { attempt: 2, message: "fixture retry", next: at })
    assert.equal(toasts.length, 1, "one transient retry toast")

    // Another session's work leaves this session's countdown alone.
    emit("session.step.started", { sessionID: "child", agent: "build", model, assistantMessageID: "msg_other", started: 2 })
    assert.deepEqual(dismissed, [])

    // The next attempt starts streaming: the backoff and its countdown are over.
    emit("session.step.started", { sessionID: "root", agent: "build", model, assistantMessageID: "msg_retry", started: 3 })
    assert.equal(session("root")?.retry, null)
    assert.equal(session("root")?.status, "working")
    assert.deepEqual(dismissed, ["toast-1"])

    emit("session.retry.scheduled", { sessionID: "root", assistantMessageID: "msg_retry", attempt: 3, at, error: retryError })
    emit("session.retry.scheduled", { sessionID: "root", assistantMessageID: "msg_retry", attempt: 4, at, error: retryError })
    assert.equal(session("root")?.retry?.attempt, 4)
    assert.equal(toasts.length, 3)
    assert.deepEqual(dismissed, ["toast-1", "toast-2"], "a newer attempt replaces the live toast")
    emit("session.execution.failed", { sessionID: "root", error: retryError })
    await settled("root")
    assert.equal(session("root")?.retry, null, "settlement clears retry state")
    assert.deepEqual(dismissed, ["toast-1", "toast-2", "toast-3"], "and ends the countdown")
  })
})
