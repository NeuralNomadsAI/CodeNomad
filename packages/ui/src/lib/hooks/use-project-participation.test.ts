import assert from "node:assert/strict"
import test from "node:test"
import { createRoot } from "solid-js"
import toast from "solid-toast"
import { useProjectParticipation } from "./use-project-participation"
import { serverEvents } from "../server-events"
import { addInstance, removeInstance, updateInstance } from "../../stores/instances"
import { appTabs, attachInstanceTab, detachInstanceTab } from "../../stores/app-tabs"
import { instanceTabAttachmentLifetime } from "../../stores/app-tab-membership"
import { restorePreviousStateEnabled } from "../../stores/client-state"
import type { Instance } from "../../types/instance"

test("real Solid tab membership publishes metadata with restore OFF, inactive tabs and fresh opaque detach lifetimes", async t => {
  const originalToast = toast.custom; toast.custom = () => "participant-notice"
  t.after(() => { toast.custom = originalToast })
  const records: Array<{ headers: Headers; body: any; signal: AbortSignal }> = []
  let emit!: (grant: { token: string; current: () => boolean } | undefined) => void
  t.mock.method(serverEvents, "onParticipation", (handler: Parameters<typeof serverEvents.onParticipation>[0]) => { emit = handler; handler(undefined); return () => {} })
  let settle!: (response: Response) => void
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    records.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)), signal: init?.signal as AbortSignal })
    if (records.length === 1) return new Promise<Response>(resolve => { settle = resolve })
    return new Response(null, { status: 204 })
  })
  let draftReads = 0
  const make = (id: string, serverId: string): Instance => {
    const instance: Instance = { id, folder: "/Opaque/é/שלום ", binding: { serverId, directory: "/Opaque/é/שלום " },
      port: 0, pid: 0, status: "ready", proxyPath: "", client: null }
    Object.defineProperty(instance, "drafts", { get() { draftReads++; throw new Error("draft getter forbidden") } })
    return instance
  }
  const a = make("participation-A", "A"), b = make("participation-B", "B"), closed = make("participation-closed", "A")
  for (const instance of [a, b, closed]) addInstance(instance)
  attachInstanceTab(a.id); attachInstanceTab(b.id)
  let dispose!: () => void
  createRoot(stop => { dispose = stop; useProjectParticipation() })
  t.after(() => { dispose(); for (const instance of [a, b, closed]) removeInstance(instance.id, { authoritative: false }) })
  assert.equal(restorePreviousStateEnabled(), false)
  assert.equal(records.length, 0, "no backend-issued grant means no publication")
  let current = true
  const oldToken = "a".repeat(64), newToken = "b".repeat(64)
  emit({ token: oldToken, current: () => current })
  assert.equal(records.length, 1)
  assert.equal(records[0]!.body.refs.length, 2)
  assert.deepEqual(new Set(records[0]!.body.refs.map((ref: any) => ref.serverId)), new Set(["A", "B"]))
  assert.ok(!records[0]!.body.refs.some((ref: any) => ref.workspaceId === closed.id))
  assert.ok(appTabs().length >= 2)
  const firstLifetime = instanceTabAttachmentLifetime(a.id)
  detachInstanceTab(a.id); attachInstanceTab(a.id)
  assert.notEqual(instanceTabAttachmentLifetime(a.id), firstLifetime, "same-turn ABA receives a new occurrence")
  current = false; emit(undefined)
  assert.equal(records[0]!.signal.aborted, true)
  emit({ token: newToken, current: () => true })
  settle(new Response(null, { status: 204 }))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(records.filter(record => record.headers.get("x-codenomad-participation") === oldToken).length, 1)
  const fresh = records.filter(record => record.headers.get("x-codenomad-participation") === newToken)
  assert.equal(fresh.length, 1, "the superseded completion triggers only the current pending declaration")
  assert.equal(fresh[0]!.body.refs.find((ref: any) => ref.workspaceId === a.id).tabId, instanceTabAttachmentLifetime(a.id))
  updateInstance(a.id, { projectName: "metadata only" })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(records.length, 2, "unchanged declaration metadata sends nothing")
  assert.equal(draftReads, 0)
  for (const record of records) {
    assert.deepEqual(Object.keys(record.body).sort(), ["refs", "revision"])
    for (const ref of record.body.refs) assert.deepEqual(Object.keys(ref).sort(), ["directory", "serverId", "tabId", "workspaceId"])
  }
})

test("ordinary tab attachment works without secure-context randomUUID and rotates its lifetime", t => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID")
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined })
  t.after(() => { if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor); else Reflect.deleteProperty(crypto, "randomUUID") })
  const instance: Instance = { id: "http-tab", folder: "/same", port: 0, pid: 0, proxyPath: "", client: null, status: "ready" }
  addInstance(instance)
  t.after(() => removeInstance(instance.id, { authoritative: false }))
  attachInstanceTab(instance.id)
  const before = instanceTabAttachmentLifetime(instance.id)!
  assert.match(before, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  detachInstanceTab(instance.id); attachInstanceTab(instance.id)
  assert.notEqual(instanceTabAttachmentLifetime(instance.id), before)
  assert.ok(appTabs().some(tab => tab.kind === "instance" && tab.instance.id === instance.id))
})

test("oversized strings and 33 live tabs publish bounded unknown rather than clipped identities", async t => {
  const originalToast = toast.custom; toast.custom = () => "participant-notice"
  t.after(() => { toast.custom = originalToast })
  let emit!: (grant: { token: string; current: () => boolean } | undefined) => void
  t.mock.method(serverEvents, "onParticipation", (handler: Parameters<typeof serverEvents.onParticipation>[0]) => { emit = handler; return () => {} })
  const bodies: any[] = []
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 })
  })
  const ids = Array.from({ length: 33 }, (_, index) => `bound-${index}`)
  for (const id of ids) {
    addInstance({ id, folder: "/same", binding: { serverId: "A", directory: "/same" }, port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
    attachInstanceTab(id)
  }
  let dispose!: () => void
  createRoot(stop => { dispose = stop; useProjectParticipation() })
  t.after(() => { dispose(); for (const id of ids) removeInstance(id, { authoritative: false }) })
  emit({ token: "c".repeat(64), current: () => true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(bodies.length, 1)
  assert.deepEqual(bodies[0], { revision: 1, refs: [], unknown: true })
  detachInstanceTab(ids[32]!)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(bodies.at(-1).refs.length, 32)
  const tooLarge = "PRIVATE_OVERSIZE".repeat(400)
  updateInstance(ids[0]!, { binding: { serverId: "A", directory: tooLarge } })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(bodies.at(-1), { revision: 3, refs: [], unknown: true })
  assert.doesNotMatch(JSON.stringify(bodies), /PRIVATE_OVERSIZE/)
  updateInstance(ids[0]!, { binding: { serverId: "A", directory: "/same" } })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(bodies.at(-1).refs.length, 32, "fresh bounded metadata recovers after each refusal")
})

test("five-second abort and disposal stop publication without retry or a pending callback send", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let emit!: (grant: { token: string; current: () => boolean } | undefined) => void, unsubscribed = false
  t.mock.method(serverEvents, "onParticipation", (handler: Parameters<typeof serverEvents.onParticipation>[0]) => { emit = handler; return () => { unsubscribed = true } })
  const signals: AbortSignal[] = []
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const signal = init!.signal as AbortSignal; signals.push(signal)
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
  })
  let dispose!: () => void
  createRoot(stop => { dispose = stop; useProjectParticipation() })
  t.after(() => dispose())
  emit({ token: "d".repeat(64), current: () => true })
  assert.equal(signals.length, 1)
  t.mock.timers.tick(5_000)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(signals[0]!.aborted, true)
  assert.equal(signals.length, 1)
  emit({ token: "e".repeat(64), current: () => true })
  assert.equal(signals.length, 2)
  dispose()
  assert.equal(unsubscribed, true)
  assert.equal(signals[1]!.aborted, true)
  emit({ token: "f".repeat(64), current: () => true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(signals.length, 2)
})

test("native local/remote Electron and Tauri plus Preferences do not subscribe to browser participation", t => {
  let subscriptions = 0
  t.mock.method(serverEvents, "onParticipation", () => { subscriptions++; return () => {} })
  const original = Object.getOwnPropertyDescriptor(globalThis, "window")
  try {
    for (const [host, context] of [["electron", "local"], ["electron", "remote"], ["tauri", "local"], ["tauri", "remote"], ["web", "preferences"]]) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: { __CODENOMAD_RUNTIME_HOST__: host, __CODENOMAD_WINDOW_CONTEXT__: context } })
      createRoot(dispose => { useProjectParticipation(); dispose() })
    }
    assert.equal(subscriptions, 0)
  } finally { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window") }
})
