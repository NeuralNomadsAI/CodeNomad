import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import type { FastifyReply, FastifyRequest } from "fastify"
import { requestAdmission } from "./request-admission"

function fixture() {
  const request = Object.assign(new EventEmitter(), { aborted: false })
  const reply = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false })
  const admission = requestAdmission({ raw: request } as unknown as FastifyRequest, { raw: reply } as unknown as FastifyReply)
  return { request, reply, admission }
}

test("normal upload close and completed response close do not revoke admission", () => {
  const h = fixture()
  h.request.emit("close")
  assert.equal(h.admission.signal.aborted, false)
  h.reply.writableFinished = true
  h.reply.emit("close")
  assert.equal(h.admission.signal.aborted, false)
  h.admission.dispose()
  assert.equal(h.request.listenerCount("aborted"), 0)
  assert.equal(h.reply.listenerCount("close"), 0)
})

test("aborted uploads and incomplete response close retire a held observer and dispose listeners", async () => {
  for (const upload of [true, false]) {
    const h = fixture()
    const pending = h.admission.wait(new Promise<void>(() => {}))
    const rejected = assert.rejects(pending, { name: "AbortError" })
    if (upload) h.request.emit("aborted")
    else h.reply.emit("close")
    await rejected
    h.admission.dispose()
    assert.equal(h.request.listenerCount("aborted"), 0)
    assert.equal(h.reply.listenerCount("close"), 0)
  }
})

test("already disconnected admission observes late rejected work without unhandled rejection", async () => {
  const h = fixture()
  h.reply.emit("close")
  await assert.rejects(h.admission.wait(Promise.reject(new Error("late shared failure"))), { name: "AbortError" })
  h.admission.dispose()
})
