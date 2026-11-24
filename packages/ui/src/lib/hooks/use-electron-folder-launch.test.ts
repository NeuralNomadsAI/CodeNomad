import assert from "node:assert/strict"
import test from "node:test"
import { installElectronFolderLaunchHandler } from "./use-electron-folder-launch"

const tick = () => new Promise((resolve) => setImmediate(resolve))

test("folder subscription is installed before one-at-a-time ordered delivery", async () => {
  const calls: string[] = []
  let notify: (() => void) | undefined
  const pending = ["/one", "/two"]
  const cleanup = installElectronFolderLaunchHandler({
    onPendingFolders: (callback) => { calls.push("subscribe"); notify = callback; return () => calls.push("unsubscribe") },
    nextPendingFolder: async () => { calls.push("next"); return pending[0] ?? null },
    acknowledgePendingFolder: async (folder, opened) => { calls.push(`ack:${folder}:${opened}`); if (opened) pending.shift() },
  }, async (folder) => { calls.push(`open:${folder}`) }, (error) => assert.fail(String(error)))
  await tick(); await tick()
  cleanup()
  assert.deepEqual(calls, ["subscribe", "next", "open:/one", "ack:/one:true", "next", "open:/two", "ack:/two:true", "next", "unsubscribe"])
})

test("failed folder opens rotate behind later entries and remain bounded by the native queue", async () => {
  const pending = ["/one", "/two"]
  const opened: string[] = []
  const acknowledgements: string[] = []
  const errors: string[] = []
  let notify: (() => void) | undefined
  let fail = true
  const cleanup = installElectronFolderLaunchHandler({
    onPendingFolders: (callback) => { notify = callback; return () => {} },
    nextPendingFolder: async () => pending[0] ?? null,
    acknowledgePendingFolder: async (folder, success) => {
      acknowledgements.push(`${folder}:${success}`)
      pending.shift()
      if (!success) pending.push(folder)
    },
  }, async (folder) => {
    opened.push(folder)
    if (fail) { fail = false; throw new Error("failed") }
  }, (error) => errors.push(String(error)))
  await tick(); await tick(); await tick()
  cleanup()
  assert.deepEqual(opened, ["/one", "/two", "/one"])
  assert.deepEqual(acknowledgements, ["/one:false", "/two:true", "/one:true"])
  assert.equal(errors.length, 1)
})

test("a false launch result is negatively acknowledged without hiding the UI error", async () => {
  const pending = ["/failed", "/later"]
  const acknowledgements: string[] = []
  const cleanup = installElectronFolderLaunchHandler({
    onPendingFolders: () => () => {},
    nextPendingFolder: async () => pending[0] ?? null,
    acknowledgePendingFolder: async (folder, opened) => {
      acknowledgements.push(`${folder}:${opened}`)
      pending.shift()
      if (!opened && folder === "/failed") pending.push(folder)
    },
  }, async (folder) => folder !== "/failed" || acknowledgements.length > 0, (error) => assert.fail(String(error)))
  await tick(); await tick(); await tick()
  cleanup()
  assert.deepEqual(acknowledgements, ["/failed:false", "/later:true", "/failed:true"])
})
