import assert from "node:assert/strict"
import test from "node:test"

import type { FormWithLocation } from "./forms"
import { createQuestionReconciliation } from "./question-reconciliation"

type SyncLocation = { directory: string; workspaceID?: string }
type MatcherCall = { form: FormWithLocation; messageId: string; partId: string }

const form = (id: string, sessionID = "session-1"): FormWithLocation => ({
  id,
  sessionID,
  title: "Question",
  fields: [{ key: "answer", type: "string", title: "Answer" }],
})

// Manual fake-time harness: timers land in a wheel keyed by fire time and are
// released by hand while the injected clock moves in explicit steps.
function harness() {
  let now = 0
  let timerSeq = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const scheduleCalls: Array<{ instanceId: string; location?: SyncLocation }> = []
  const matcherCalls: MatcherCall[] = []
  const getFormsCalls: number[] = []
  let forms: FormWithLocation[] = []
  let decide: (call: MatcherCall) => boolean = () => false
  const sessionLocations = new Map<string, SyncLocation>()

  const reconciliation = createQuestionReconciliation({
    schedule: (instanceId, location) => {
      scheduleCalls.push({ instanceId, location })
    },
    getForms: () => {
      getFormsCalls.push(now)
      return forms
    },
    matchesForm: (candidate, messageId, partId) => {
      const call = { form: candidate, messageId, partId }
      matcherCalls.push(call)
      return decide(call)
    },
    getSessionLocation: (instanceId, sessionId) => sessionLocations.get(`${instanceId}\0${sessionId}`),
    now: () => now,
    setTimer: ((callback: () => void, ms?: number) => {
      const id = ++timerSeq
      timers.set(id, { at: now + (ms ?? 0), callback })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout,
    clearTimer: ((handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number)
    }) as unknown as typeof clearTimeout,
  })

  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      let due: { id: number; at: number; callback: () => void } | undefined
      for (const [id, timer] of timers) {
        if (timer.at <= target && (due === undefined || timer.at < due.at)) {
          due = { id, at: timer.at, callback: timer.callback }
        }
      }
      if (!due) break
      timers.delete(due.id)
      now = due.at
      due.callback()
    }
    now = target
  }

  return {
    reconciliation,
    advance,
    scheduleCalls,
    matcherCalls,
    getFormsCalls,
    setForms: (next: FormWithLocation[]) => {
      forms = next
    },
    setMatch: (next: (call: MatcherCall) => boolean) => {
      decide = next
    },
    setSessionLocation: (instanceId: string, sessionId: string, location: SyncLocation) => {
      sessionLocations.set(`${instanceId}\0${sessionId}`, location)
    },
    pendingTimers: () => timers.size,
  }
}

test("a running question part with no dock form schedules one targeted sync after the grace", () => {
  const h = harness()
  h.setSessionLocation("instance-1", "session-1", { directory: "/repo/a", workspaceID: "ws-1" })
  h.reconciliation.onQuestionPart("instance-1", "session-1", "msg-1", "part-1", true)
  h.advance(1_999)
  assert.deepEqual(h.scheduleCalls, [], "nothing syncs before the grace elapses")
  h.advance(1)
  assert.deepEqual(h.scheduleCalls, [
    { instanceId: "instance-1", location: { directory: "/repo/a", workspaceID: "ws-1" } },
  ])
  h.advance(1_000)
  assert.equal(h.scheduleCalls.length, 1, "the grace fires exactly one sync")
})

test("a matching dock form appearing before the grace elapses cancels the schedule", () => {
  const h = harness()
  h.reconciliation.onQuestionPart("instance-1", "session-1", "msg-1", "part-1", true)
  h.advance(1_000)
  h.setForms([form("form-1")])
  h.setMatch(({ form: candidate, messageId, partId }) => candidate.id === "form-1" && messageId === "msg-1" && partId === "part-1")
  h.advance(1_000)
  assert.deepEqual(h.scheduleCalls, [], "the docked form cancelled the grace sync")
  assert.equal(h.pendingTimers(), 0, "the episode left no timers behind")
  h.advance(60_000)
  assert.deepEqual(h.scheduleCalls, [], "a cancelled episode never syncs later")
})

test("a still-missing form gets one grace sync and exactly one retry, never more", () => {
  const h = harness()
  h.reconciliation.onQuestionPart("instance-1", "session-1", "msg-1", "part-1", true)
  h.advance(2_000)
  assert.deepEqual(h.scheduleCalls, [{ instanceId: "instance-1", location: undefined }])
  h.advance(5_999)
  assert.equal(h.scheduleCalls.length, 1, "no retry before 6 s after the first sync")
  h.advance(1)
  assert.equal(h.scheduleCalls.length, 2, "exactly one retry 6 s after the first sync")
  h.advance(10 * 60_000)
  assert.equal(h.scheduleCalls.length, 2, "no further syncs ever")
  assert.equal(h.pendingTimers(), 0)
})

test("a settled part disarms its pending timers", () => {
  const early = harness()
  early.reconciliation.onQuestionPart("instance-1", "session-1", "msg-1", "part-1", true)
  early.advance(1_000)
  early.reconciliation.onQuestionPart("instance-1", "session-1", "msg-1", "part-1", false)
  early.advance(60_000)
  assert.deepEqual(early.scheduleCalls, [], "settling before the grace leaves zero syncs")
  assert.equal(early.pendingTimers(), 0)

  const mid = harness()
  mid.reconciliation.onQuestionPart("instance-1", "session-1", "msg-1", "part-1", true)
  mid.advance(2_000)
  assert.equal(mid.scheduleCalls.length, 1)
  mid.reconciliation.onQuestionPart("instance-1", "session-1", "msg-1", "part-1", false)
  mid.advance(60_000)
  assert.equal(mid.scheduleCalls.length, 1, "settling after the first sync leaves one sync total")
  assert.equal(mid.pendingTimers(), 0, "the pending retry was disarmed")
})

test("a second question part re-arms with its own bounded episodes", () => {
  const h = harness()
  h.reconciliation.onQuestionPart("instance-1", "session-1", "msg-1", "part-1", true)
  h.reconciliation.onQuestionPart("instance-1", "session-1", "msg-1", "part-1", true)
  h.advance(2_000)
  h.advance(6_000)
  assert.equal(h.scheduleCalls.length, 2, "a repeated running:true never adds budget to the same episode")
  h.advance(60_000)
  assert.equal(h.scheduleCalls.length, 2)

  h.reconciliation.onQuestionPart("instance-1", "session-1", "msg-1", "part-2", true)
  h.advance(2_000)
  assert.equal(h.scheduleCalls.length, 3, "the second part armed its own grace sync")
  h.advance(6_000)
  assert.equal(h.scheduleCalls.length, 4, "the second part got its own bounded retry")
  h.advance(60_000)
  assert.equal(h.scheduleCalls.length, 4, "both episodes are spent")

  h.reconciliation.onQuestionPart("instance-1", "session-1", "msg-2", "part-1", true)
  h.advance(2_000)
  assert.equal(h.scheduleCalls.length, 5)
  h.reconciliation.onQuestionPart("instance-1", "session-1", "msg-2", "part-1", false)
  h.reconciliation.onQuestionPart("instance-1", "session-1", "msg-2", "part-1", true)
  h.advance(2_000)
  assert.equal(h.scheduleCalls.length, 6, "a running:true after a settle starts a new bounded episode")
  h.advance(3_999)
  assert.equal(h.scheduleCalls.length, 6, "the disarmed retry from the old episode never resurfaces")
  h.advance(6_001)
  assert.equal(h.scheduleCalls.length, 7, "the re-armed episode runs its own bounded retry")
  h.advance(60_000)
  assert.equal(h.scheduleCalls.length, 7, "both episodes are spent")
})

test("evaluation consults getForms and matchesForm at fire time, not at arm time", () => {
  const h = harness()
  h.setMatch(({ messageId, partId }) => messageId === "msg-1" && partId === "part-1")
  h.reconciliation.onQuestionPart("instance-1", "session-1", "msg-1", "part-1", true)
  assert.equal(h.getFormsCalls.length, 0, "arming consults no dock state")
  assert.equal(h.matcherCalls.length, 0)
  const lateForm = form("form-late")
  h.advance(1_000)
  h.setForms([lateForm])
  h.advance(1_000)
  assert.deepEqual(h.matcherCalls, [{ form: lateForm, messageId: "msg-1", partId: "part-1" }])
  assert.deepEqual(h.scheduleCalls, [], "the form that appeared cancels the sync")
  assert.ok(h.getFormsCalls.every((at) => at >= 2_000), "getForms only ran during evaluation")
})
