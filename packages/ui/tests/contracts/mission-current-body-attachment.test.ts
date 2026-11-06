import assert from "node:assert/strict"
import test from "node:test"
import { contentDigest } from "../../../server/src/missions/content-digest"
import { createMissionContentStore, type MissionBodyRef } from "../../src/stores/mission-content-store"

const flush = async () => { for (let tick = 0; tick < 40; tick++) await Promise.resolve() }
const text = "0123456789", digest = contentDigest(text)

for (const owner of ["daily", "scheduled"] as const) {
  const ref: MissionBodyRef = { instanceId: "fixture", projectID: "project", missionID: "msn_current",
    selector: { kind: "task", taskKey: "work", field: "brief" },
    passage: { owner, projectID: "project", scheduleID: "schedule", passageID: "passage", missionID: "msn_current", digest: "a".repeat(43) } }
  const answer = (offset: number) => ({ available: true as const, version: 1 as const, projectID: ref.projectID, missionID: ref.missionID, revision: 1,
    content: { ...ref.selector, digest, offset, characters: text.length, text: text.slice(offset, offset + 5), ...(offset === 0 ? { next: 5 } : {}) } })

  test(`${owner} current-body demand reacquires an independent attachment lifetime and rejects late old IO`, async t => {
    let attachment = new AbortController(), clock = 0
    t.mock.method(performance, "now", () => clock)
    const reads: Array<{ signal: AbortSignal; deadline?: number; resolve: (value: ReturnType<typeof answer>) => void }> = []
    const store = createMissionContentStore((_ref, _query, signal, deadline) => new Promise(resolve => {
      reads.push({ signal, deadline, resolve })
    }), undefined, () => attachment.signal)
    const a = store.use(ref, "connection"), b = store.use(ref, "connection")
    a.need(Infinity); b.need(10)
    try {
      reads[0].resolve(answer(0)); await flush()
      assert.equal(reads.length, 2); assert.equal(reads[0].signal, reads[1].signal)
      attachment.abort(); attachment = new AbortController(); clock = 10_000
      store.invalidate(ref.instanceId)
      assert.equal(reads.length, 3); assert.equal(reads[1].signal.aborted, true)
      assert.notEqual(reads[2].signal, reads[1].signal); assert.equal(reads[2].deadline, 40_000)
      reads[1].resolve(answer(5)); await flush()
      assert.equal(a.state().body?.text, "01234"); assert.equal(reads.length, 3)
      reads[2].resolve(answer(0)); await flush()
      assert.equal(reads.length, 4); assert.equal(reads[2].signal, reads[3].signal)
      a.release(); assert.equal(reads[3].signal.aborted, false)
      reads[3].resolve(answer(5)); await flush()
      assert.equal(b.state().body?.text, text); assert.equal(b.state().status, "ready")
    } finally { a.release(); b.release() }
  })

  test(`${owner} an original deadline parks even an invalidated current-body read awaiting late IO`, async t => {
    const timeout = new AbortController(), attachment = new AbortController()
    t.mock.method(AbortSignal, "timeout", () => timeout.signal)
    let clock = 0, resolve!: (value: ReturnType<typeof answer>) => void
    t.mock.method(performance, "now", () => clock)
    let calls = 0
    const store = createMissionContentStore(async (_ref, query) => {
      calls++
      return calls === 1 ? answer(0) : new Promise(done => { resolve = done })
    }, undefined, () => attachment.signal)
    const handle = store.use(ref, "connection"); handle.need(Infinity)
    try {
      await flush(); assert.equal(calls, 2)
      store.invalidate(ref.instanceId)
      clock = 30_000; timeout.abort(new DOMException("Expired", "TimeoutError")); await flush()
      assert.equal(handle.state().status, "error"); assert.equal(handle.state().body?.text, "01234")
      resolve(answer(5)); await flush()
      assert.equal(handle.state().status, "error"); assert.equal(calls, 2)
    } finally { handle.release(); resolve?.(answer(5)) }
  })
}
