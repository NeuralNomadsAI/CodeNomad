import assert from "node:assert/strict"
import test from "node:test"
import { createMissionWriterRetirement } from "./writer-retirement"

test("retirement closes admission immediately and waits for both native unregister and admitted work", async () => {
  const writer = createMissionWriterRetirement()
  let releaseWork!: () => void, releaseUnregister!: () => void
  const workGate = new Promise<void>(resolve => { releaseWork = resolve })
  const unregisterGate = new Promise<void>(resolve => { releaseUnregister = resolve })
  let entered = false, unregistered = 0, retired = false
  const work = writer.run(async () => { entered = true; await workGate })
  const closing = writer.retire(async () => { unregistered++; await unregisterGate }).then(() => { retired = true })
  await assert.rejects(writer.run(async () => {}), /no longer available/)
  await Promise.resolve()
  assert.equal(entered, true)
  assert.equal(unregistered, 1)
  releaseUnregister()
  await Promise.resolve()
  assert.equal(retired, false, "unregister is not a drain")
  releaseWork()
  await Promise.all([work, closing, writer.retire(async () => { throw new Error("called twice") })])
  assert.equal(retired, true)
  assert.equal(unregistered, 1)
})

test("failed unregister never completes retirement, even after a failed admitted operation", async () => {
  const writer = createMissionWriterRetirement()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const work = writer.run(async () => { await gate; throw new Error("effect failed") })
  let finished = false
  const closing = writer.retire(() => { throw new Error("unregister failed") }).finally(() => { finished = true })
  await Promise.resolve()
  assert.equal(finished, false, "even synchronous unregister failure must drain admitted work")
  release()
  await assert.rejects(work, /effect failed/)
  await assert.rejects(closing, /unregister failed/)
  await assert.rejects(writer.retire(async () => {}), /unregister failed/)
  await assert.rejects(writer.run(async () => {}), /no longer available/)
})

test("a rejected asynchronous write remains unknown and rejects retirement even after unregister succeeds", async () => {
  const writer = createMissionWriterRetirement()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const write = writer.write(async () => { await gate; throw new Error("native set outcome unknown") })
  let unregistered = 0, retired = false
  const closing = writer.retire(async () => { unregistered++ }).finally(() => { retired = true })
  await Promise.resolve()
  assert.equal(retired, false)
  release()
  await assert.rejects(write, /outcome unknown/)
  await assert.rejects(closing, /outcome unknown/)
  assert.equal(unregistered, 1)
  await assert.rejects(writer.retire(async () => { throw new Error("unsafe retry") }), /outcome unknown/)
  const harmless = createMissionWriterRetirement()
  await assert.rejects(harmless.run(async () => { throw new Error("read failed") }), /read failed/)
  await harmless.retire(async () => {})
})
