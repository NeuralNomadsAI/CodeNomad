import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ShellInfo } from "@opencode/client"
import { appendShellOutput, createShellApi, createShellStore, type ShellApi } from "./shell-store.ts"
import { OpenCode } from "@opencode/client"

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
    const incomplete = appendShellOutput("\u001b[", "1".repeat(4 * 1024 * 1024))
    assert.equal(incomplete.output, "")
    const osc = appendShellOutput("\u001b]0;title\u0007", "a".repeat(4 * 1024 * 1024 - 9))
    assert.equal(osc.output.startsWith("]0;title"), false)
    const terminatedOsc = appendShellOutput("\u001b]0;title\u001b\\", "a".repeat(4 * 1024 * 1024))
    assert.equal(terminatedOsc.output.length, 4 * 1024 * 1024)
    const splitTerminator = appendShellOutput("\u001b]0;title\u001b\\", "a".repeat(4 * 1024 * 1024 - 1))
    assert.equal(splitTerminator.output.startsWith("\\"), false)
    const multilineOsc = appendShellOutput("\u001b]title\nmore\u0007", "a".repeat(4 * 1024 * 1024 - 4))
    assert.equal(multilineOsc.output.startsWith("ore\u0007"), false)
    const dcs = appendShellOutput("\u001bPpayload\u001b\\", "a".repeat(4 * 1024 * 1024 - 4))
    assert.equal(dcs.output.startsWith("oad\u001b\\"), false)
    const cancelledDcs = appendShellOutput("\u001bPpayload\u0018VISIBLE", "a".repeat(4 * 1024 * 1024 - 4))
    assert.equal(cancelledDcs.output.startsWith("IBLE"), true)
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

  it("keeps same-directory native Shell states and refresh identities separate", async () => {
    const lists: Array<string | undefined> = []
    const removals: Array<string | undefined> = []
    const store = createShellStore(() => ({
      list: async (_directory, workspaceID) => { lists.push(workspaceID); return [shell(workspaceID!)] },
      remove: async (_directory, _id, workspaceID) => { removals.push(workspaceID) },
      output: async () => ({ output: "", cursor: 0, size: 0, truncated: false }),
    }))
    await store.load("instance", "/repo", "one")
    await store.load("instance", "/repo", "two")
    assert.equal(store.getState("instance", "/repo", "one").items[0].id, "one")
    assert.equal(store.getState("instance", "/repo", "two").items[0].id, "two")
    lists.length = 0
    await store.refreshForEvent("instance", { type: "shell.created", location: { directory: "/repo", workspaceID: "two" } })
    assert.deepEqual(lists, ["two"])
    await store.remove("instance", "/repo", "one", "one")
    assert.deepEqual(removals, ["one"])
  })

  it("generated Shell requests preserve workspace context and native output cursors", async () => {
    const operations: string[] = []
    const api = createShellApi(OpenCode.make({ baseUrl: "http://localhost", fetch: async (input, init) => {
      const request = new Request(input, init)
      assert.deepEqual(JSON.parse(decodeURIComponent(request.headers.get("x-codenomad-location")!)), { directory: "/repo", workspaceID: "one" })
      const url = new URL(request.url)
      operations.push(request.method + url.pathname)
      assert.equal(url.searchParams.get("location[directory]"), "/repo")
      if (url.pathname.endsWith("/output")) {
        assert.equal(url.searchParams.get("cursor"), "17")
        return Response.json({ data: { output: "fixture", cursor: 29, size: 29, truncated: false } })
      }
      return request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ data: [shell("one")] })
    } }))
    await api.list("/repo", "one")
    assert.equal((await api.output("/repo", "one", 17, "one")).cursor, 29)
    await api.remove("/repo", "one", "one")
    assert.deepEqual(operations, ["GET/api/shell", "GET/api/shell/one/output", "DELETE/api/shell/one"])
  })
})
