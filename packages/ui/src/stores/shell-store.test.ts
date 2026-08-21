import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ShellInfo } from "@opencode-ai/client"
import { appendShellOutput, createShellStore, type ShellApi } from "./shell-store.ts"

const shell = (id: string, cwd = "/repo"): ShellInfo => ({
  id, command: "npm run dev", cwd, shell: "sh", file: "/tmp/output", status: "running", pid: 42, metadata: {}, time: { started: 1 },
})

describe("shell store", () => {
  it("bounds retained shell output to its newest four MiB", () => {
    const result = appendShellOutput("a".repeat(4 * 1024 * 1024), "tail")
    assert.equal(result.output.length, 4 * 1024 * 1024)
    assert.equal(result.output.endsWith("tail"), true)
    assert.equal(result.truncated, true)
  })

  it("does not retain split Unicode or ANSI control sequences", () => {
    const unicode = appendShellOutput("😀", "a".repeat(4 * 1024 * 1024 - 1))
    assert.equal(unicode.output.startsWith("\ude00"), false)
    const ansi = appendShellOutput("\u001b[31m", "a".repeat(4 * 1024 * 1024 - 4))
    assert.equal(ansi.output.startsWith("[31m"), false)
  })

  it("keeps state location-scoped and refreshes on shell events and reconnect", async () => {
    const lists: string[] = []
    const api: ShellApi = {
      list: async (directory) => { lists.push(directory); return [shell(directory, directory)] },
      remove: async () => {},
      output: async () => ({ output: "", cursor: 0, size: 0, truncated: false }),
    }
    const store = createShellStore(() => api)
    await store.load("instance", "/repo")
    await store.load("instance", "/repo/worktree")
    lists.length = 0

    await store.refreshForEvent("instance", { type: "pty.created", location: { directory: "/repo" } })
    assert.deepEqual(lists, [])
    await store.refreshForEvent("instance", { type: "shell.created", data: { info: { cwd: "/repo" } } })
    assert.deepEqual(lists, ["/repo"])
    lists.length = 0
    await store.refreshForEvent("instance", { type: "server.connected" })
    assert.deepEqual(lists.sort(), ["/repo", "/repo/worktree"])
  })

  it("keeps loaded shells visible when removal fails", async () => {
    const api: ShellApi = {
      list: async () => [shell("shell")],
      remove: async () => { throw new Error("failed") },
      output: async () => ({ output: "", cursor: 0, size: 0, truncated: false }),
    }
    const store = createShellStore(() => api)
    await store.load("instance", "/repo")

    assert.equal(await store.remove("instance", "/repo", "shell"), false)
    assert.equal(store.getState("instance", "/repo").failed, false)
    assert.equal(store.getState("instance", "/repo").items.length, 1)
  })
})
