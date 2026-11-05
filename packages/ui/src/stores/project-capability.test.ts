import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot } from "solid-js"
import { addInstance, updateInstance, removeInstance } from "./instances"
import { createProjectAdmission } from "./project-capability"
import { initialServerCapabilities } from "../../../server/src/opencode/servers/capabilities"
import { serverApi } from "../lib/api-client"
import { getWorktrees, reloadWorktrees } from "./worktrees"
import { destroyOpenCodeData } from "./opencode-data"
import { missionStore, activateMissionDemand } from "./missions"

test("explicit Missions remain closed at paged inventory and task dispatch", async () => {
  const id = "project-capability-remote-missions", originalPanel = serverApi.fetchMissionPanel, originalTasks = serverApi.fetchMissionTasks
  let reads = 0
  serverApi.fetchMissionPanel = async () => { reads++; throw new Error("Remote panel read") }
  serverApi.fetchMissionTasks = async () => { reads++; throw new Error("Remote task read") }
  addInstance({ id, folder: "/same/", binding: { serverId: "remote", directory: "/same/" }, status: "ready", client: {} as any, port: 0, pid: 0, proxyPath: "" })
  try {
    activateMissionDemand(id)
    assert.equal(missionStore.demandedInstanceIds().includes(id), false)
    await missionStore.ensure(id)
    await missionStore.loadTasks(id, "mission", { offset: 0 })
    assert.equal(reads, 0)
    assert.deepEqual(missionStore.state(id).missions, [])
  } finally {
    missionStore.clear(id); removeInstance(id, { authoritative: false })
    serverApi.fetchMissionPanel = originalPanel; serverApi.fetchMissionTasks = originalTasks
  }
})

test("local reader lifetime survives metadata refresh, and rotates only with its captured source", () => {
  const id = "project-capability-local-lifetime"
  addInstance({ id, folder: "/same/", status: "ready", client: null, port: 0, pid: 0, proxyPath: "" })
  createRoot(dispose => {
    try {
      const admission = createProjectAdmission(() => id, () => "files")
      const first = admission()
      assert.ok(first)
      updateInstance(id, { projectName: "Display metadata refreshed" })
      assert.equal(admission(), first)
      updateInstance(id, { capabilities: initialServerCapabilities({ kind: "local-shared", id: "local-shared" } as any, 2 as any) })
      const rotated = admission()
      assert.ok(rotated)
      assert.notEqual(rotated, first)
      destroyOpenCodeData(id)
      assert.ok(admission())
      assert.notEqual(admission(), rotated, "native reconnect replaces the captured local reader instead of freezing it")
      const revoked = initialServerCapabilities({ kind: "local-shared", id: "local-shared" } as any, 2 as any)
      revoked.features.files.state = "unavailable"
      updateInstance(id, { capabilities: revoked })
      assert.equal(admission(), false)
    } finally { dispose() }
  })
})

test("a local replacement never joins a retired worktree read or publishes its late result", async () => {
  const id = "project-capability-worktree-replacement", original = serverApi.fetchWorktrees
  addInstance({ id, folder: "/same/", status: "ready", client: null, port: 0, pid: 0, proxyPath: "" })
  let release!: () => void, started!: () => void, reads = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { started = resolve })
  serverApi.fetchWorktrees = async () => {
    const old = ++reads === 1
    if (old) { started(); await gate }
    return { worktrees: [{ slug: old ? "retired" : "current", directory: "/same/", kind: "root" }] }
  }
  try {
    const old = reloadWorktrees(id)
    await reading
    updateInstance(id, { client: {} as any })
    await reloadWorktrees(id)
    assert.equal(reads, 2)
    assert.equal(getWorktrees(id)[0]?.slug, "current")
    release(); await old
    assert.equal(getWorktrees(id)[0]?.slug, "current")
  } finally { release(); serverApi.fetchWorktrees = original }
})
