import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { after, test } from "node:test"
import type { MissionScheduleRead } from "../../../server/src/api-types"
import { HttpResponseError } from "../lib/retryable-file-search"
import type { MissionEditorDraft } from "../stores/mission-editor-state"

const attachment = new AbortController()
const fixture = {
  fetchSchedule: async (_instance: string, _id: string, _input?: { directory?: string; requestID?: string }, _signal?: AbortSignal): Promise<MissionScheduleRead> => {
    throw new Error("unconfigured")
  },
  fetchCreation: async (_instance: string, _requestID: string, _directory?: string, _signal?: AbortSignal): Promise<MissionScheduleRead> => {
    throw new Error("unconfigured")
  },
  saveSchedule: async (_instance: string, _input: any, _signal?: AbortSignal): Promise<MissionScheduleRead> => {
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

const partialHttpError = () => new HttpResponseError("Mission schedule action remains unconfirmed", 503, null, "schedule-pending", {
  ...partialRead,
  missionID: baseRequest.missionID,
  pending: true,
  code: "schedule-pending",
  error: "Mission schedule action remains unconfirmed",
})

test("503 schedule-pending partial receipt retries once, stays pending across remount, and notifies the reopened editor on settlement", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const scope = "scope-auto-retry-pending"
  releaseMissionScheduleEditor(scope, baseRequest.requestID)
  holdMissionScheduleEditor(scope, baseRequest, draft)
  retainMissionScheduleEditor(scope, baseRequest.requestID)

  let receiptCalls = 0, firstSaved = 0, reopenedSaved = 0
  const retryInputs: any[] = [], retrySignals: Array<AbortSignal | undefined> = []
  const postGate = deferred<MissionScheduleRead>()
  fixture.fetchSchedule = async (_instance, _id, input) => {
    if (input?.requestID) { receiptCalls++; throw partialHttpError() }
    return partialRead
  }
  fixture.saveSchedule = async (_instance, input, signal) => {
    retryInputs.push(input); retrySignals.push(signal); return postGate.promise
  }

  const first = mountEditor(scope, { onSaved: () => { firstSaved++ } })
  try {
    await flush()
    assert.equal(receiptCalls, 1)
    assert.equal(retryInputs.length, 1)
    assert.deepEqual(retryInputs[0], { ...baseRequest, retry: true })
    assert.ok(retrySignals[0] instanceof AbortSignal, "retry POST must receive a bounded AbortSignal")
    assert.equal(retrySignals[0]!.aborted, false)
    assert.equal(missionScheduleEditorHold(scope)?.state, "pending")

    // Close and reopen while the automatic retry POST is still in flight.
    first.dispose()
    const reopened = mountEditor(scope, { onSaved: () => { reopenedSaved++ } })
    try {
      await flush()
      t.mock.timers.tick(MISSION_HELD_REREAD_MS * 3)
      await flush()
      assert.equal(receiptCalls, 1, "reopened editor must not auto-reread while retry POST is pending")
      assert.equal(retryInputs.length, 1, "reopened editor must not send a second retry while first POST is in flight")
      assert.equal(missionScheduleEditorHold(scope)?.state, "pending")

      postGate.resolve(completeRead)
      await flush()
      assert.equal(missionScheduleEditorHold(scope), undefined, "completed retry releases the shared hold")
      assert.equal(retryInputs.length, 1)
      assert.equal(firstSaved, 0, "disposed editor does not invoke onSaved after unmount")
      assert.equal(reopenedSaved, 1, "reopened editor observes settlement and invokes onSaved once")
    } finally { reopened.dispose() }
  } finally {
    first.dispose()
    releaseMissionScheduleEditor(scope, baseRequest.requestID)
  }
})

test("503 schedule-pending with a mismatched partial receipt never retries and keeps the hold", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const scope = "scope-mismatched-503"
  releaseMissionScheduleEditor(scope, baseRequest.requestID)
  holdMissionScheduleEditor(scope, baseRequest, draft)
  retainMissionScheduleEditor(scope, baseRequest.requestID)

  let receiptCalls = 0, retryCalls = 0
  fixture.fetchSchedule = async (_instance, _id, input) => {
    if (input?.requestID) {
      receiptCalls++
      throw new HttpResponseError("Mission schedule action remains unconfirmed", 503, null, "schedule-pending", {
        ...partialRead,
        missionID: baseRequest.missionID,
        pending: true,
        code: "schedule-pending",
        error: "Mission schedule action remains unconfirmed",
        document: {
          ...partialRead.document!,
          control: { action: "configure", requestID: "req_other", expectedRevision: 1, pending: true },
        },
      })
    }
    return partialRead
  }
  fixture.saveSchedule = async () => { retryCalls++; return completeRead }

  const mounted = mountEditor(scope)
  try {
    await flush()
    t.mock.timers.tick(MISSION_HELD_REREAD_MS)
    await flush()
    assert.equal(receiptCalls, 2)
    assert.equal(retryCalls, 0, "mismatched 503 receipt must never trigger retry")
    const held = missionScheduleEditorHold(scope)
    assert.equal(held?.state, "uncertain")
    assert.deepEqual(JSON.parse(held!.payload), baseRequest)
  } finally {
    mounted.dispose()
    releaseMissionScheduleEditor(scope, baseRequest.requestID)
  }
})

test("timed-out automatic partial retry restores uncertain hold and resumes polling without minting a new requestID", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const scope = "scope-retry-timeout-identity"
  releaseMissionScheduleEditor(scope, baseRequest.requestID)
  holdMissionScheduleEditor(scope, baseRequest, draft)
  retainMissionScheduleEditor(scope, baseRequest.requestID)

  let receiptCalls = 0, saved = 0
  const retryInputs: any[] = [], retrySignals: Array<AbortSignal | undefined> = []
  fixture.fetchSchedule = async (_instance, _id, input) => {
    if (input?.requestID) { receiptCalls++; throw partialHttpError() }
    return partialRead
  }
  fixture.saveSchedule = async (_instance, input, signal) => {
    retryInputs.push(input); retrySignals.push(signal)
    if (retryInputs.length === 1) throw new DOMException("Timed out", "TimeoutError")
    return completeRead
  }

  const mounted = mountEditor(scope, { onSaved: () => { saved++ } })
  try {
    await flush()
    assert.equal(receiptCalls, 1)
    assert.equal(retryInputs.length, 1, "timed-out retry must not spin immediately before the next reread interval")
    assert.ok(retrySignals[0] instanceof AbortSignal)
    assert.deepEqual(retryInputs[0], { ...baseRequest, retry: true })
    const heldAfterFailure = missionScheduleEditorHold(scope)
    assert.equal(heldAfterFailure?.state, "uncertain")
    assert.deepEqual(JSON.parse(heldAfterFailure!.payload), baseRequest)

    t.mock.timers.tick(MISSION_HELD_REREAD_MS)
    await flush()
    assert.equal(receiptCalls, 2)
    assert.equal(retryInputs.length, 2)
    assert.deepEqual(retryInputs[1], { ...baseRequest, retry: true }, "retry never mints a new request ID")
    assert.equal(missionScheduleEditorHold(scope), undefined)
    assert.equal(saved, 1)
  } finally {
    mounted.dispose()
    releaseMissionScheduleEditor(scope, baseRequest.requestID)
  }
})

test("successful retry publishes onSaved once even after the earlier receipt-read deadline expires", async () => {
  const scope = "scope-retry-after-read-deadline"
  releaseMissionScheduleEditor(scope, baseRequest.requestID)
  holdMissionScheduleEditor(scope, baseRequest, draft)
  retainMissionScheduleEditor(scope, baseRequest.requestID)

  const originalTimeout = AbortSignal.timeout
  const timeouts: AbortController[] = []
  AbortSignal.timeout = (() => {
    const controller = new AbortController()
    timeouts.push(controller)
    return controller.signal
  }) as typeof AbortSignal.timeout

  let saved = 0
  const postGate = deferred<MissionScheduleRead>()
  let readSignal: AbortSignal | undefined, retrySignal: AbortSignal | undefined
  fixture.fetchSchedule = async (_instance, _id, input, signal) => {
    if (input?.requestID) { readSignal = signal; throw partialHttpError() }
    return partialRead
  }
  fixture.saveSchedule = async (_instance, _input, signal) => { retrySignal = signal; return postGate.promise }

  const mounted = mountEditor(scope, { onSaved: () => { saved++ } })
  try {
    await flush()
    assert.ok(readSignal && retrySignal)
    assert.equal(timeouts.length >= 2, true)
    // Expire the receipt-read deadline while the retry POST is still in flight.
    timeouts.at(-2)!.abort(new DOMException("Timed out", "TimeoutError"))
    assert.equal(readSignal.aborted, true, "receipt-read signal must be expired")
    assert.equal(retrySignal.aborted, false, "retry POST owns its own deadline")
    postGate.resolve(completeRead)
    await flush()
    assert.equal(missionScheduleEditorHold(scope), undefined)
    assert.equal(saved, 1, "successful retry must publish onSaved exactly once without double-firing")
  } finally {
    AbortSignal.timeout = originalTimeout
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
