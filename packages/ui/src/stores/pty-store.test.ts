import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OpenCodeClient, Pty } from "@opencode-ai/client"
import { createPtyApi, createPtyStore, type PtyApi } from "./pty-store.ts"

const pty = (id: string, cwd = "/repo"): Pty => ({
  id,
  title: id,
  command: "npm",
  args: ["run", "dev"],
  cwd,
  status: "running",
  pid: 42,
})

describe("native PTY adapter", () => {
  it("passes the exact location and native PTY inputs", async () => {
    const calls: unknown[] = []
    const client = {
      pty: {
        list: async (input: unknown) => { calls.push(["list", input]); return { data: [pty("one")] } },
        get: async (input: unknown) => { calls.push(["get", input]); return { data: pty("one") } },
        update: async (input: unknown) => { calls.push(["update", input]); return { data: { ...pty("one"), title: "renamed" } } },
        remove: async (input: unknown) => { calls.push(["remove", input]) },
      },
    } as unknown as OpenCodeClient
    const api = createPtyApi(client)

    assert.deepEqual(await api.list("/repo/worktree"), [pty("one")])
    assert.equal((await api.get("/repo/worktree", "one")).id, "one")
    assert.equal((await api.updateTitle("/repo/worktree", "one", "renamed")).title, "renamed")
    await api.remove("/repo/worktree", "one")

    assert.deepEqual(calls, [
      ["list", { location: { directory: "/repo/worktree" } }],
      ["get", { ptyID: "one", location: { directory: "/repo/worktree" } }],
      ["update", { ptyID: "one", location: { directory: "/repo/worktree" }, title: "renamed" }],
      ["remove", { ptyID: "one", location: { directory: "/repo/worktree" } }],
    ])
  })
})

describe("PTY store", () => {
  it("keeps state location-scoped and refreshes only on exact PTY events and reconnect", async () => {
    const lists: string[] = []
    const api: PtyApi = {
      list: async (directory) => { lists.push(directory); return [pty(directory, directory)] },
      get: async () => pty("unused"),
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

  it("refreshes authoritative state after rename and remove controls", async () => {
    const controls: unknown[] = []
    let items = [pty("one")]
    const api: PtyApi = {
      list: async () => items,
      get: async () => items[0]!,
      updateTitle: async (_directory, id, title) => {
        controls.push(["update", id, title])
        items = [{ ...items[0]!, title }]
        return items[0]!
      },
      remove: async (_directory, id) => {
        controls.push(["remove", id])
        items = []
      },
    }
    const store = createPtyStore(() => api)
    await store.load("instance", "/repo")
    assert.equal(await store.updateTitle("instance", "/repo", "one", "renamed"), true)
    assert.equal(store.getState("instance", "/repo").items[0]?.title, "renamed")
    assert.equal(await store.remove("instance", "/repo", "one"), true)
    assert.deepEqual(store.getState("instance", "/repo").items, [])
    assert.deepEqual(controls, [["update", "one", "renamed"], ["remove", "one"]])
  })
})
