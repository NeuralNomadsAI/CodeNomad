import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, unlink, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { followPresence, PRESENCE_INTERVAL_MS } from "../desktop-plugin-presence"

test("close idle, close busy, reopen and settle share one registration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mission-presence-"))
  const lease = path.join(directory, "abc.lease")
  let registrations = 0, disposals = 0, work = false
  await writeFile(lease, "")
  const cleanup = await followPresence(directory, async () => {
    registrations++
    return () => { disposals++ }
  }, error => { throw error }, async () => work)
  const tick = () => delay(PRESENCE_INTERVAL_MS + 200)
  try {
    assert.equal(registrations, 1)
    await unlink(lease)
    await tick()
    assert.equal(disposals, 1, "idle close unregisters")
    await writeFile(lease, "")
    await tick()
    assert.equal(registrations, 2)
    work = true
    await unlink(lease)
    await tick()
    assert.equal(disposals, 1, "busy close retains")
    await writeFile(lease, "")
    await tick()
    assert.equal(registrations, 2, "reopening retained work does not duplicate setup")
    await unlink(lease)
    work = false
    await tick()
    assert.equal(disposals, 2, "settling after close unregisters")
  } finally {
    await cleanup()
    await rm(directory, { recursive: true, force: true })
  }
})

test("native unload wins over retained work", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mission-presence-"))
  await writeFile(path.join(directory, "abc.lease"), "")
  let disposals = 0
  const cleanup = await followPresence(directory, async () => () => { disposals++ },
    error => { throw error }, async () => true)
  await cleanup()
  assert.equal(disposals, 1)
  await rm(directory, { recursive: true, force: true })
})

test("cleanup waits for in-flight registration and prevents callback resurrection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mission-presence-"))
  const lease = path.join(directory, "abc.lease")
  let setups = 0, disposals = 0
  let release: (() => void) | undefined
  const cleanup = await followPresence(directory, async () => {
    setups++
    await new Promise<void>(resolve => { release = resolve })
    return () => { disposals++ }
  })
  try {
    await writeFile(lease, "")
    for (let i = 0; !release && i < 50; i++) await delay(100)
    assert(release, "poll entered registration")
    let cleaned = false
    const pending = cleanup().then(() => { cleaned = true })
    await delay(20)
    assert.equal(cleaned, false)
    release()
    await pending
    assert.equal(disposals, 1, "late registration is immediately disposed")
    await delay(PRESENCE_INTERVAL_MS + 200)
    assert.equal(setups, 1, "still-live presence cannot resurrect after cleanup")
    assert.equal(disposals, 1)
  } finally {
    release?.()
    await cleanup()
    await rm(directory, { recursive: true, force: true })
  }
})
