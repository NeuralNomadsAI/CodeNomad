import assert from "node:assert/strict"
import { it } from "node:test"
import { createEffect, createRoot } from "solid-js"
import { createShellStore, type ShellApi } from "./shell-store.ts"

it("does not subscribe a calling effect to internal shell loading state", async () => {
  let listCalls = 0
  let effectRuns = 0
  const api: ShellApi = {
    list: async () => { listCalls += 1; return [] },
    remove: async () => {},
    output: async () => ({ output: "", cursor: 0, size: 0, truncated: false }),
  }
  const store = createShellStore(() => api)
  let dispose = () => {}

  await new Promise<void>((resolve) => {
    createRoot((rootDispose) => {
      dispose = rootDispose
      createEffect(() => {
        effectRuns += 1
        void store.load("instance", "/repo").then(resolve)
      })
    })
  })
  await Promise.resolve()
  dispose()

  assert.equal(effectRuns, 1)
  assert.equal(listCalls, 1)
})
