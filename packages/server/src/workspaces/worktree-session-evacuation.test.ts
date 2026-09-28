import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { evacuateWorktreeSessions, WorktreeDeletionFence } from "./worktree-session-evacuation"
import { readInternalLocationContext } from "./__tests__/location-context-fixture"

function session(id: string, directory: string, parentID?: string): SessionInfo {
  return { id, parentID, projectID: "project", location: { directory }, cost: 0, tokens: {}, time: { created: 1, updated: 1 } } as SessionInfo
}

const location = { get: async ({ location }: { location: { directory: string } }) => location }

describe("evacuateWorktreeSessions", () => {
  it("drains overlapping directory-only identities across Git availability transitions", async () => {
    for (const [active, deleted] of [["/repo/nested", "/repo"], ["/repo", "/repo/nested"]]) {
      const fence = new WorktreeDeletionFence()
      const release = fence.enter([active])!
      let removed = false
      const deletion = fence.run(deleted, [deleted], async () => { removed = true })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(removed, false)
      assert.equal(fence.enter([active]), undefined)
      assert.equal(fence.isBlocked(active), true)
      const releaseSibling = fence.enter(["/repo-other"])
      assert.ok(releaseSibling)
      releaseSibling()
      release()
      await deletion
      assert.equal(removed, true)
    }
  })
  it("serializes deletion attempts for the same worktree", async () => {
    const fence = new WorktreeDeletionFence()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls: string[] = []
    const first = fence.run("/repo/worktree", ["/repo/worktree"], async () => {
      calls.push("first:start")
      await gate
      calls.push("first:end")
    })
    const second = fence.run("/repo/worktree", ["/repo/worktree"], async () => { calls.push("second") })

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, ["first:start"])
    assert.equal(fence.isBlocked("/repo/worktree/"), true)
    release()
    await Promise.all([first, second])
    assert.deepEqual(calls, ["first:start", "first:end", "second"])
    assert.equal(fence.isBlocked("/repo/worktree"), false)
  })

  it("waits for admitted mutations before deleting and rejects later admission", async () => {
    const fence = new WorktreeDeletionFence()
    const releaseMutation = fence.enter(["/repo/worktree"])
    assert.ok(releaseMutation)
    const calls: string[] = []
    const deletion = fence.run("/repo/worktree", ["/repo/worktree"], async () => { calls.push("delete") })

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [])
    assert.equal(fence.enter(["/repo/worktree"]), undefined)
    releaseMutation()
    await deletion
    assert.deepEqual(calls, ["delete"])
  })

  it("fails deletion closed when an admitted mutation does not finish", async () => {
    const fence = new WorktreeDeletionFence(1)
    const releaseMutation = fence.enter(["/repo/worktree"])
    assert.ok(releaseMutation)

    await assert.rejects(
      fence.run("/repo/worktree", ["/repo/worktree"], async () => {}),
      /Timed out waiting for worktree mutations/,
    )
    assert.equal(fence.isBlocked("/repo/worktree"), false)
    releaseMutation()
  })

  it("finds later-page sessions and waits for their asynchronous moves", async () => {
    const moves: Array<{ sessionID: string; directory: string }> = []
    const lists: unknown[] = []
    let listCall = 0
    const root = session("old-root", "/repo/worktree")
    const child = session("old-child", "/repo/worktree", root.id)
    const grandchild = session("old-grandchild", "/repo/worktree", child.id)
    const state = new Map([root, child, grandchild].map((item) => [item.id, item]))
    let removed = false
    const client = {
      location,
      project: {
        list: async () => [{ id: "project", canonical: "/repo", sandboxes: ["/repo/worktree"], time: { created: 1, updated: 1 } }],
      },
      session: {
        list: async (input: unknown) => {
          lists.push(input)
          listCall += 1
          if (listCall === 1) return { data: [session("loaded", "/repo")], cursor: { next: "older" } }
          if (listCall === 2) return { data: [root, child, grandchild], cursor: {} }
          return { data: [session("loaded", "/repo"), ...state.values()], cursor: {} }
        },
        active: async () => ({}),
        move: async (input: { sessionID: string; directory: string }) => {
          moves.push(input)
          setImmediate(() => state.set(input.sessionID, { ...state.get(input.sessionID)!, location: { directory: input.directory } }))
        },
      },
    } as unknown as OpenCodeClient

    await evacuateWorktreeSessions({
      client, projectDirectory: "/repo", targetDirectory: "/repo/worktree", rootDirectory: "/repo",
      remove: async () => { removed = true },
    })

    assert.deepEqual(moves.map(({ sessionID }) => sessionID), [root.id, child.id, grandchild.id])
    assert.equal(removed, true)
    assert.ok(listCall > 3)
    assert.ok(lists.every((input: any) => input.cursor
      ? Object.keys(input).length === 1
      : input.project === "project" && input.directory === undefined))
  })

  it("evacuates sessions whose directory resolves to the target alias", async () => {
    const aliased = session("aliased", "/repo/alias")
    let current = aliased
    let removed = false
    const client = {
      location,
      project: { list: async () => [{ id: "project", canonical: "/repo", sandboxes: ["/repo/worktree"], time: { created: 1, updated: 1 } }] },
      session: {
        list: async () => ({ data: [current], cursor: {} }),
        active: async () => ({}),
        move: async (input: { directory: string }) => { current = { ...current, location: { directory: input.directory } } },
      },
    } as unknown as OpenCodeClient

    await evacuateWorktreeSessions({
      client,
      projectDirectory: "/repo",
      targetDirectory: "/repo/worktree",
      rootDirectory: "/repo",
      resolveDirectoryIdentity: async (directory) => directory === "/repo/alias" ? "/repo/worktree" : directory,
      remove: async () => { removed = true },
    })

    assert.equal(current.location.directory, "/repo")
    assert.equal(removed, true)
  })

  it("resolves the project canonical path without collapsing containing-worktree identity", async () => {
    const shortRoot = "C:\\Users\\RUNNER~1\\Temp\\repo"
    const longRoot = "C:/Users/runneradmin/Temp/repo"
    const target = `${shortRoot}\\worktree`
    const original = { directory: target, workspaceID: "native-original" }
    const current = { ...session("session", target), location: original }
    const moves: unknown[] = []
    const client = {
      location: { get: async () => ({ directory: longRoot }) },
      project: { list: async () => [
        { id: "foreign", canonical: "C:/Users/runneradmin/Temp/repo-other", sandboxes: [] },
        { id: "project", canonical: longRoot, sandboxes: [] },
      ] },
      session: {
        list: async ({ project }: { project: string }) => {
          assert.equal(project, "project")
          return { data: [current], cursor: {} }
        },
        active: async () => ({}),
        move: async ({ directory }: { directory: string }, options?: { headers: Record<string, string> }) => {
          const location = readInternalLocationContext(options?.headers["x-codenomad-location"]) ?? { directory }
          moves.push(location)
          current.location = location as typeof original
        },
      },
    } as unknown as OpenCodeClient
    await assert.rejects(evacuateWorktreeSessions({
      client, projectDirectory: shortRoot, targetDirectory: target, rootDirectory: shortRoot,
      resolveDirectoryIdentity: async directory => directory === shortRoot || directory === longRoot
        ? "owned:root" : directory === target ? "owned:worktree" : undefined,
      resolveExactDirectory: async directory => directory === shortRoot || directory === longRoot
        ? longRoot : directory === target ? target : undefined,
      remove: async () => {
        assert.deepEqual(current.location, { directory: longRoot })
        throw new Error("Synthetic Git removal refusal")
      },
    }), /Synthetic Git removal refusal/)
    assert.deepEqual(moves, [{ directory: longRoot }, original])
    assert.deepEqual(current.location, original)
  })

  it("inventories the exact project when nested projects and sandboxes share its worktree identity", async () => {
    const inventories: string[] = []
    let removed = false
    const client = {
      location,
      project: { list: async () => [
        { id: "nested", canonical: "/repo/nested", sandboxes: [] },
        { id: "nested-sandbox", canonical: "/other", sandboxes: ["/repo/worktree/nested"] },
        { id: "project", canonical: "/repo", sandboxes: ["/repo/worktree"] },
      ] },
      session: {
        list: async ({ project }: { project: string }) => {
          inventories.push(project)
          return { data: project === "project" ? [session("active", "/repo/worktree/child")] : [], cursor: {} }
        },
        active: async () => ({ active: { type: "running" } }),
        move: async () => { assert.fail("Active sessions must not move") },
      },
    } as unknown as OpenCodeClient
    await assert.rejects(evacuateWorktreeSessions({
      client, projectDirectory: "/repo", targetDirectory: "/repo/worktree", rootDirectory: "/repo",
      resolveDirectoryIdentity: async directory => directory.startsWith("/repo/worktree") ? "/repo/worktree" : "/repo",
      resolveExactDirectory: async directory => directory.startsWith("/repo") ? directory : undefined,
      remove: async () => { removed = true },
    }), /Active sessions block worktree deletion: active/)
    assert.deepEqual(inventories, ["project"])
    assert.equal(removed, false)
  })

  it("keeps WSL directory translation exact and refuses an owned nested evacuation destination", async () => {
    const hostRoot = "\\\\wsl.localhost\\Ubuntu\\home\\fixture\\repo"
    const hostTarget = `${hostRoot}\\worktree`
    const translate = async (directory: string) => directory === hostRoot ? "/home/fixture/repo"
      : directory === hostTarget ? "/home/fixture/repo/worktree" : directory
    let destination = "/home/fixture/repo/nested"
    let removed = false
    let moved = false
    const client = {
      location: { get: async () => ({ directory: destination }) },
      project: { list: async () => [{ id: "project", canonical: "/home/fixture/repo", sandboxes: [] }] },
      session: {
        list: async () => ({ data: [], cursor: {} }),
        active: async () => ({}),
        move: async () => { moved = true },
      },
    } as unknown as OpenCodeClient
    const params = {
      client, projectDirectory: hostRoot, targetDirectory: hostTarget, rootDirectory: hostRoot,
      resolveDirectoryIdentity: async (directory: string) => (await translate(directory)).includes("/worktree") ? "owned:worktree" : "owned:root",
      resolveExactDirectory: translate,
      remove: async () => { removed = true },
    }
    await assert.rejects(evacuateWorktreeSessions(params), /foreign evacuation destination/)
    assert.equal(removed, false)
    assert.equal(moved, false)
    destination = "/home/fixture/repo"
    await evacuateWorktreeSessions(params)
    assert.equal(removed, true)
  })

  it("fails closed when an exact directory cannot be resolved", async () => {
    await assert.rejects(evacuateWorktreeSessions({
      client: {} as OpenCodeClient, projectDirectory: "/repo", targetDirectory: "/repo/worktree", rootDirectory: "/repo",
      resolveDirectoryIdentity: async () => "owned:root",
      resolveExactDirectory: async () => undefined,
      remove: async () => { assert.fail("Unresolved directories must not be deleted") },
    }), /Unable to resolve owned directories/)
  })

  it("resolves a real junction/symlink project alias without admitting a foreign destination", async () => {
    const temp = path.join(os.tmpdir(), "opencode")
    await mkdir(temp, { recursive: true })
    const root = await mkdtemp(path.join(temp, "evacuation-alias-"))
    try {
      const canonical = path.join(root, "repository")
      const alias = path.join(root, "alias")
      const target = path.join(root, "worktree")
      const foreign = path.join(root, "foreign")
      await Promise.all([canonical, target, foreign].map(directory => mkdir(directory)))
      await symlink(canonical, alias, process.platform === "win32" ? "junction" : "dir")
      let destination = await realpath(canonical)
      let current = session("session", target)
      const moves: string[] = []
      const client = {
        location: { get: async () => ({ directory: destination }) },
        project: { list: async () => [{ id: "project", canonical: destination, sandboxes: [] }] },
        session: {
          list: async () => ({ data: [current], cursor: {} }),
          active: async () => ({}),
          move: async ({ directory }: { directory: string }) => {
            moves.push(directory)
            current = { ...current, location: { directory } }
          },
        },
      } as unknown as OpenCodeClient
      const params = {
        client, projectDirectory: alias, targetDirectory: target, rootDirectory: alias,
        resolveDirectoryIdentity: (directory: string) => realpath(directory),
        resolveExactDirectory: (directory: string) => realpath(directory),
        remove: async () => { throw new Error("Synthetic Git removal refusal") },
      }
      await assert.rejects(evacuateWorktreeSessions(params), /Synthetic Git removal refusal/)
      assert.deepEqual(moves, [destination, target])
      assert.equal(current.location.directory, target)
      moves.length = 0
      destination = foreign
      await assert.rejects(evacuateWorktreeSessions(params), /Unable to resolve the OpenCode project/)
      assert.deepEqual(moves, [])
      client.project.list = async () => [{ id: "project", canonical, sandboxes: [] }] as any
      await assert.rejects(evacuateWorktreeSessions(params), /foreign evacuation destination/)
      assert.deepEqual(moves, [])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("evacuates sessions nested under the target worktree identity", async () => {
    let current = session("nested", "/repo/worktree/nested")
    let removed = false
    const client = {
      location,
      project: { list: async () => [{ id: "project", canonical: "/repo", sandboxes: ["/repo/worktree"], time: { created: 1, updated: 1 } }] },
      session: {
        list: async () => ({ data: [current], cursor: {} }),
        active: async () => ({}),
        move: async (input: { directory: string }) => { current = { ...current, location: { directory: input.directory } } },
      },
    } as unknown as OpenCodeClient

    await evacuateWorktreeSessions({
      client,
      projectDirectory: "/repo",
      targetDirectory: "/repo/worktree",
      rootDirectory: "/repo",
      resolveDirectoryIdentity: async (directory) => directory.startsWith("/repo/worktree") ? "workspace:worktree" : "workspace:root",
      remove: async () => { removed = true },
    })

    assert.equal(current.location.directory, "/repo")
    assert.equal(removed, true)
  })

  it("rolls sessions back when Git removal fails", async () => {
    const current = session("session", "/repo/worktree")
    const moves: string[] = []
    const client = {
      location,
      project: { list: async () => [{ id: "project", canonical: "/repo", sandboxes: ["/repo/worktree"], time: { created: 1, updated: 1 } }] },
      session: {
        list: async () => ({ data: [current], cursor: {} }),
        active: async () => ({}),
        move: async ({ directory }: { directory: string }) => {
          moves.push(directory)
          current.location = { directory }
        },
      },
    } as unknown as OpenCodeClient

    await assert.rejects(evacuateWorktreeSessions({
      client, projectDirectory: "/repo", targetDirectory: "/repo/worktree", rootDirectory: "/repo",
      remove: async () => { throw new Error("Git removal failed") },
    }), /Git removal failed/)
    assert.deepEqual(moves, ["/repo", "/repo/worktree"])
    assert.equal(current.location.directory, "/repo/worktree")
  })

  it("re-inventories active sessions immediately before removal", async () => {
    const current = session("session", "/repo/worktree")
    const intruder = session("intruder", "/repo/worktree")
    let listCalls = 0
    let removed = false
    const client = {
      location,
      project: { list: async () => [{ id: "project", canonical: "/repo", sandboxes: ["/repo/worktree"], time: { created: 1, updated: 1 } }] },
      session: {
        list: async () => {
          listCalls += 1
          return { data: listCalls >= 3 ? [current, intruder] : [current], cursor: {} }
        },
        active: async () => ({ intruder: { type: "running" } }),
        move: async ({ directory }: { directory: string }) => { current.location = { directory } },
      },
    } as unknown as OpenCodeClient

    await assert.rejects(evacuateWorktreeSessions({
      client, projectDirectory: "/repo", targetDirectory: "/repo/worktree", rootDirectory: "/repo",
      remove: async () => { removed = true },
    }), /Active sessions block worktree deletion: intruder/)

    assert.equal(removed, false)
    assert.equal(current.location.directory, "/repo/worktree")
  })

  it("uses the resolved destination and restores exact legacy identity on rollback", async () => {
    const original = { directory: "/repo/worktree", workspaceID: "native-original" }
    const destination = { directory: "/repo", workspaceID: "native-root" }
    const current = { ...session("session", original.directory), location: original }
    const moves: unknown[] = []
    const client = {
      location: { get: async () => destination },
      project: { list: async () => [{ id: "project", canonical: "/repo", sandboxes: [original.directory] }] },
      session: {
        list: async () => ({ data: [current], cursor: {} }),
        active: async () => ({}),
        move: async ({ directory }: { directory: string }, options?: { headers: Record<string, string> }) => {
          const resolved = readInternalLocationContext(options?.headers["x-codenomad-location"])!
          assert.equal(resolved.directory, directory)
          moves.push(resolved)
          current.location = { directory: resolved.directory, workspaceID: resolved.workspaceID! }
        },
      },
    } as unknown as OpenCodeClient
    await assert.rejects(evacuateWorktreeSessions({
      client, projectDirectory: "/repo", targetDirectory: original.directory, rootDirectory: destination.directory,
      remove: async () => { throw new Error("Git removal failed") },
    }), /Git removal failed/)
    assert.deepEqual(moves, [destination, original])
    assert.deepEqual(current.location, original)
  })

  it("does not report rollback success when only the directory was restored", async () => {
    const original = { directory: "/repo/worktree", workspaceID: "native-original" }
    const current = { ...session("session", original.directory), location: original }
    let moves = 0
    const client = {
      location,
      project: { list: async () => [{ id: "project", canonical: "/repo", sandboxes: [original.directory] }] },
      session: {
        list: async () => ({ data: [current], cursor: {} }),
        active: async () => ({}),
        move: async ({ directory }: { directory: string }) => {
          moves++
          current.location = { directory, workspaceID: undefined! }
        },
      },
    } as unknown as OpenCodeClient
    await assert.rejects(evacuateWorktreeSessions({
      client, projectDirectory: "/repo", targetDirectory: original.directory, rootDirectory: "/repo",
      remove: async () => { throw new Error("Git removal failed") },
    }), /could not be rolled back/)
    assert.equal(moves, 2)
  })
})
