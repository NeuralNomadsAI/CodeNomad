import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { waitForPluginActivation } from "./plugin-activation.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe("plugin activation", () => {
  it("coalesces concurrent waits for the same client and location", async () => {
    const gate = deferred()
    const calls: unknown[] = []
    const client = {
      plugin: {
        awaitActivation: async (input: unknown) => {
          calls.push(input)
          await gate.promise
        },
      },
    } as any

    const first = waitForPluginActivation(client, { directory: "/repo", workspaceID: "worktree" })
    const duplicate = waitForPluginActivation(client, { directory: "/repo", workspaceID: "worktree" })
    const other = waitForPluginActivation(client, { directory: "/other" })
    await Promise.resolve()

    assert.equal(first, duplicate)
    assert.deepEqual(calls, [
      { location: { directory: "/repo", workspace: "worktree" } },
      { location: { directory: "/other" } },
    ])

    gate.resolve()
    await Promise.all([first, duplicate, other])
  })

  it("falls back to catalog reads and retries after an unsupported wait route", async () => {
    let calls = 0
    const client = {
      plugin: {
        awaitActivation: async () => {
          calls += 1
          throw new Error("unsupported")
        },
      },
    } as any

    await waitForPluginActivation(client, { directory: "/repo" })
    await waitForPluginActivation(client, { directory: "/repo" })
    assert.equal(calls, 2)
  })
})
