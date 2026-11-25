import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { after, test } from "node:test"
import type { MissionScheduleRead } from "../../../server/src/api-types"
import type { MissionEditorDraft } from "../stores/mission-editor-state"

const attachment = new AbortController()
const fixture = {
  fetchSchedule: async (_instance: string, _id: string, _input?: { directory?: string; requestID?: string }, _signal?: AbortSignal): Promise<MissionScheduleRead> => {
    throw new Error("unconfigured")
  },
  fetchCreation: async (_instance: string, _requestID: string, _directory?: string, _signal?: AbortSignal): Promise<MissionScheduleRead> => {
    throw new Error("unconfigured")
  },
  saveSchedule: async (_instance: string, _input: any): Promise<MissionScheduleRead> => {
    throw new Error("unconfigured")
  },
  client: () => ({}),
  generation: () => 0,
  backendEvents: {
    signalForInstance: () => attachment.signal,
    on: () => () => {},
    forInstance: () => ({ onOpen: () => () => {} }),
  },
}
;(globalThis as any).__missionEditorScheduleTest = fixture

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "solid-js") return next("solid-js/dist/solid.js", context)
    const sources: Record<string, string> = {
      "../lib/backend-client": `const f = globalThis.__missionEditorScheduleTest; export const backendOf = () => ({ api: {
        fetchMissionScheduleCapability: async () => ({ location: { directory: "/repo" }, api: { available: true }, enabled: true, origin: null, activation: { available: false, reason: "missing-api", targets: [] } }),
        fetchMissionSchedule: (...args) => f.fetchSchedule(...args),
        fetchMissionScheduleCreation: (...args) => f.fetchCreation(...args),
        saveMissionSchedule: (...args) => f.saveSchedule(...args),
        fetchMission: async () => { throw new Error("unused") },
        fetchMissionContent: async () => { throw new Error("unused") },
      } });`,
      "../lib/server-events": "export const backendEvents = globalThis.__missionEditorScheduleTest.backendEvents;",
      "./backend-events": "export const backendEvents = globalThis.__missionEditorScheduleTest.backendEvents;",
      "../stores/instances": "export const instances = () => new Map([['instance', { client: globalThis.__missionEditorScheduleTest.client() }]]);",
      "../stores/opencode-data": "export const getOpenCodeInstanceGeneration = () => globalThis.__missionEditorScheduleTest.generation();",
    }
    if (context.parentURL?.endsWith("/backend-operation.ts") && specifier === "./backend-events")
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources["./backend-events"])}` }
    if (context.parentURL?.endsWith("/mission-editor-schedule.ts") && sources[specifier])
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` }
    return next(specifier, context)
  },
})
after(() => { hooks.deregister(); delete (globalThis as any).__missionEditorScheduleTest })

const { createRoot, createSignal } = await import("solid-js")
const { createMissionEditorScheduling } = await import("./mission-editor-schedule")
const { MISSION_HELD_REREAD_MS } = await import("../lib/mission-held-reread")
const { holdMissionScheduleEditor, missionScheduleEditorHold, releaseMissionScheduleEditor, retainMissionScheduleEditor } = await import("../stores/mission-schedule-editor-holds")

const deferred = <T = void>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }

const baseRequest = {
  action: "configure" as const,
  missionID: "msn_1",
  requestID: "req_partial",
  expectedRevision: 1,
  directory: "/repo",
  configuration: {
    title: "Prepared",
    objective: "Inspect",
    notes: "",
    template: "custom" as const,
    taskMode: "native" as const,
    profiles: {
      coordinator: { agent: "coordinator", model: { providerID: "p", id: "m" } },
      roles: { specialist: { agent: "specialist", model: { providerID: "p", id: "m" } } },
    },
    watchedConversationIDs: [],
    launch: { when: [] },
  },
}
const partialRead: MissionScheduleRead = {
  pending: true,
  document: {
    id: "msn_1",
    kind: "one-time",
    revision: 1,
    configuration: { ...baseRequest.configuration, roots: [{ mode: "directory-only", directory: "/repo" }], profileID: null, executionHost: null },
    control: { action: "configure", requestID: "req_partial", expectedRevision: 1, pending: true },
  } as any,
}
const completeRead: MissionScheduleRead = {
  pending: false,
  document: {
    ...partialRead.document!,
    revision: 2,
    control: { action: "configure", requestID: "req_partial", expectedRevision: 1, pending: false },
  },
}
const draft = { objective: "Inspect", notes: "", template: "custom" } as MissionEditorDraft

function mountEditor(scope: string, options: { active?: () => boolean; owner?: () => string; onSaved?: () => void } = {}) {
  let dispose!: () => void
  const active = options.active ?? (() => true)
  const owner = options.owner ?? (() => "owner-1")
  const controller = createRoot(cleanup => {
    dispose = cleanup
    return createMissionEditorScheduling({
      instanceId: "instance",
      directory: "/repo",
      action: { kind: "edit", scheduleID: "msn_1" },
      scope: () => scope,
      owner,
      active,
      captureView: () => () => active(),
      onLoad: () => {},
      captureDraft: () => draft,
      onSaved: () => options.onSaved?.(),
    })
  })
  return { controller, dispose }
}

test("retryPreparation marks the shared hold pending across remount so automatic reread and duplicate retries wait until settlement", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const scope = "scope-retry-pending"
  releaseMissionScheduleEditor(scope, baseRequest.requestID)
  holdMissionScheduleEditor(scope, baseRequest, draft)
  retainMissionScheduleEditor(scope, baseRequest.requestID)

  let receiptCalls = 0, postCalls = 0, saved = 0
  const postGate = deferred<MissionScheduleRead>()
  fixture.fetchSchedule = async (_instance, _id, input) => {
    if (input?.requestID) { receiptCalls++; return partialRead }
    return partialRead
  }
  fixture.saveSchedule = async () => { postCalls++; return postGate.promise }

  const first = mountEditor(scope, { onSaved: () => { saved++ } })
  try {
    await flush()
    assert.equal(first.controller.retryable(), true)
    const retrying = first.controller.retryPreparation()
    await flush()
    assert.equal(postCalls, 1)
    assert.equal(missionScheduleEditorHold(scope)?.state, "pending")

    // Close and reopen while retry POST is still in flight.
    const readsBeforeReopen = receiptCalls
    first.dispose()
    const reopened = mountEditor(scope, { onSaved: () => { saved++ } })
    try {
      await flush()
      t.mock.timers.tick(MISSION_HELD_REREAD_MS * 3)
      await flush()
      assert.equal(receiptCalls, readsBeforeReopen, "reopened editor must not auto-reread while retry POST is pending")
      assert.equal(reopened.controller.retryable(), false, "reopened editor must not offer another retry while first POST is in flight")
      assert.equal(missionScheduleEditorHold(scope)?.state, "pending")

      postGate.resolve(completeRead)
      await retrying
      await flush()
      assert.equal(missionScheduleEditorHold(scope), undefined, "completed retry releases the shared hold")
      assert.equal(postCalls, 1)
    } finally { reopened.dispose() }
  } finally {
    first.dispose()
    releaseMissionScheduleEditor(scope, baseRequest.requestID)
  }
})

test("automatic receipt polling keeps retryable stable mid-poll and only changes it on response", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const scope = "scope-retryable-stable"
  releaseMissionScheduleEditor(scope, baseRequest.requestID)
  holdMissionScheduleEditor(scope, baseRequest, draft)
  retainMissionScheduleEditor(scope, baseRequest.requestID)

  let receiptCalls = 0
  const secondPoll = deferred<MissionScheduleRead>()
  fixture.fetchSchedule = async (_instance, _id, input) => {
    if (!input?.requestID) return partialRead
    receiptCalls++
    if (receiptCalls === 1) return partialRead
    return secondPoll.promise
  }

  const mounted = mountEditor(scope)
  try {
    await flush()
    assert.equal(receiptCalls, 1)
    assert.equal(mounted.controller.retryable(), true)

    t.mock.timers.tick(MISSION_HELD_REREAD_MS)
    await flush()
    assert.equal(receiptCalls, 2)
    assert.equal(mounted.controller.retryable(), true, "retryable must stay true while the next poll is in flight")
    assert.equal(mounted.controller.reading(), false, "background polling must not disable the Try again button")

    secondPoll.resolve({ pending: true, document: null })
    await flush()
    assert.equal(mounted.controller.retryable(), false, "retryable clears only when the response says it is no longer partial")
  } finally {
    secondPoll.resolve({ pending: true, document: null })
    mounted.dispose()
    releaseMissionScheduleEditor(scope, baseRequest.requestID)
  }
})

test("stalled automatic receipt read is cancelled on owner change or unmount and recovers after timeout", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const scope = "scope-abort-recover"
  releaseMissionScheduleEditor(scope, baseRequest.requestID)
  holdMissionScheduleEditor(scope, baseRequest, draft)
  retainMissionScheduleEditor(scope, baseRequest.requestID)

  const signals: AbortSignal[] = []
  let mode: "stall" | "timeout" | "complete" = "stall"
  let saved = 0
  fixture.fetchSchedule = async (_instance, _id, input, signal) => {
    if (!input?.requestID) return partialRead
    assert.ok(signal, "automatic receipt read must receive a bounded AbortSignal")
    signals.push(signal)
    if (mode === "stall") {
      return new Promise<MissionScheduleRead>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true })
      })
    }
    if (mode === "timeout") throw new DOMException("Timed out", "TimeoutError")
    return completeRead
  }

  const [owner, setOwner] = createSignal("owner-1")
  const mounted = mountEditor(scope, { owner, onSaved: () => { saved++ } })
  try {
    await flush()
    assert.equal(signals.length, 1)
    assert.equal(signals[0].aborted, false)

    // Owner change aborts the stalled read and immediately starts a fresh one.
    mode = "timeout"
    setOwner("owner-2")
    await flush()
    assert.equal(signals[0].aborted, true, "owner change must abort the stalled receipt read")
    assert.equal(signals.length, 2)

    // After a timed-out read, the next interval tick must not stay wedged and must settle when the server replies.
    mode = "complete"
    t.mock.timers.tick(MISSION_HELD_REREAD_MS)
    await flush()
    assert.equal(signals.length, 3)
    assert.equal(missionScheduleEditorHold(scope), undefined)
    assert.equal(saved, 1)
  } finally {
    mounted.dispose()
    releaseMissionScheduleEditor(scope, baseRequest.requestID)
  }

  // Cleanup/unmount also aborts a stalled read.
  holdMissionScheduleEditor(scope, baseRequest, draft)
  retainMissionScheduleEditor(scope, baseRequest.requestID)
  mode = "stall"
  const second = mountEditor(scope)
  await flush()
  const lastSignal = signals.at(-1)!
  assert.equal(lastSignal.aborted, false)
  second.dispose()
  assert.equal(lastSignal.aborted, true, "unmount must abort an in-flight automatic receipt read")
  releaseMissionScheduleEditor(scope, baseRequest.requestID)
})
