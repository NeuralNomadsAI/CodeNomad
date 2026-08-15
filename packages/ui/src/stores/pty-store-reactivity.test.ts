import assert from "node:assert/strict"
import { it } from "node:test"
import type { Pty } from "@opencode-ai/client"
import { createEffect, createRoot } from "solid-js"
import { createPtyStore, type PtyApi } from "./pty-store.ts"

const unusedPty = (): Pty => ({
  id: "unused",
  title: "unused",
  command: "npm",
  args: [],
  cwd: "/repo",
  status: "running",
  pid: 42,
})

it("does not subscribe a calling effect to internal PTY loading state", async () => {
  let listCalls = 0
  let effectRuns = 0
  const api: PtyApi = {
    list: async () => { listCalls += 1; return [] },
    get: async () => unusedPty(),
    updateTitle: async () => unusedPty(),
    remove: async () => {},
  }
  const store = createPtyStore(() => api)
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
