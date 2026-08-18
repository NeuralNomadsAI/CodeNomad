import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Pty } from "@opencode-ai/client"
import { createPtyStore, type PtyApi } from "./pty-store.ts"

const pty = (id: string, cwd = "/repo"): Pty => ({
  id,
  title: id,
  command: "npm",
  args: ["run", "dev"],
  cwd,
  status: "running",
  pid: 42,
})

describe("PTY store", () => {
  it("keeps state location-scoped and refreshes only on exact PTY events and reconnect", async () => {
    const lists: string[] = []
    const api: PtyApi = {
      list: async (directory) => { lists.push(directory); return [pty(directory, directory)] },
      updateTitle: async () => pty("unused"),
      remove: async () => {},
    }
    const store = createPtyStore(() => api)
    await store.load("instance", "/repo")
    await store.load("instance", "/repo/worktree")
    lists.length = 0

    await store.refreshForEvent("instance", { type: "session.updated", location: { directory: "/repo" } })
    assert.deepEqual(lists, [])
    await store.refreshForEvent("instance", { type: "pty.updated", location: { directory: "/repo/worktree" } })
    assert.deepEqual(lists, ["/repo/worktree"])
    lists.length = 0
    await store.refreshForEvent("instance", { type: "pty.created", data: { info: { cwd: "/repo" } } })
    assert.deepEqual(lists, ["/repo"])
    lists.length = 0
    await store.refreshForEvent("instance", { type: "server.connected" })
    assert.deepEqual(lists.sort(), ["/repo", "/repo/worktree"])
  })
})
