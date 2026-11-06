import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { WorkspaceDescriptor } from "../../../server/src/api-types"
import type { Instance } from "../types/instance.ts"
import { attachInstanceTab } from "./app-tabs.ts"
import { appTabs } from "./app-tabs.ts"
import { onInstanceLifecycleAuthority, type InstanceLifecycleAuthorityEvent } from "./instance-lifecycle-authority.ts"
import { addInstance, getExistingInstanceForFolder, instances, refreshWorkspaceList, removeInstance } from "./instances.ts"
import { captureState } from "../lib/hooks/use-app-session-capture.ts"
import { renameProject } from "./project-names"
import { projectScope } from "../lib/backend-identity"
import { missionProjectView, updateMissionProjectView } from "./mission-view-state"
import { closeSessionPreview, getSessionPreview, openSessionPreview, showSessionChatFor } from "./session-previews"
import { serverApi } from "../lib/api-client"

const instance = (id: string, backendId?: string): Instance => ({
  id, ...(backendId ? { backendId } : {}), folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${id}`,
  status: "starting", client: null, environmentVariables: {},
})
const descriptor = (id: string): WorkspaceDescriptor => ({
  id, path: "/repo", name: "repo", status: "starting", proxyPath: `/workspaces/${id}`,
  binaryId: "opencode", binaryLabel: "opencode", createdAt: "", updatedAt: "",
})

describe("workspace lists of two backends", () => {
  it("refuses a non-local refresh without that backend's API", async () => {
    await assert.rejects(refreshWorkspaceList("lab"), /needs its backend API/)
  })
  it("never closes the tabs of a backend whose list was not refreshed", async () => {
    const local = instance("w-local"), lab = instance("lab~w1", "lab")
    const events: InstanceLifecycleAuthorityEvent[] = []
    const stop = onInstanceLifecycleAuthority((event) => { events.push(event) })
    addInstance(local)
    addInstance(lab)
    try {
      // Same folder, two backends: each is the first occurrence of its own project.
      assert.deepEqual(events.map(({ instanceId, occurrence, backendId }) => [instanceId, occurrence, backendId]),
        [["w-local", 0, undefined], ["lab~w1", 0, "lab"]])
      attachInstanceTab(local.id)
      attachInstanceTab(lab.id)
      const captured = captureState(new Map()).state
      assert.deepEqual(captured.tabs.map(tab => tab.kind === "workspace" ? [tab.backendId, tab.folder, tab.occurrence] : null),
        [[undefined, "/repo", 0], ["lab", "/repo", 0]])
      assert.equal(getExistingInstanceForFolder("/repo")?.id, "w-local")
      assert.equal(getExistingInstanceForFolder("/repo", "lab")?.id, "lab~w1")
      await renameProject("/repo", "Lab repository", "lab")
      assert.equal(instances().get(lab.id)?.projectName, "Lab repository")
      assert.equal(instances().get(local.id)?.projectName, undefined)

      // The local list no longer has any workspace: only local instances are reconciled.
      await refreshWorkspaceList("local", { fetchWorkspaces: async () => [] })
      assert.deepEqual([...instances().keys()], ["lab~w1"])
      assert.deepEqual(appTabs().map(({ id }) => id), ["instance:lab~w1"])

      // The other backend's list keys its workspaces under that backend.
      await refreshWorkspaceList("lab", { fetchWorkspaces: async () => [descriptor("w2")] })
      assert.deepEqual([...instances().keys()], ["lab~w2"])
      assert.equal(instances().get("lab~w2")?.backendId, "lab")
      assert.equal(instances().get("lab~w2")?.folder, "/repo")
    } finally {
      stop()
      for (const id of [...instances().keys()]) removeInstance(id, { authoritative: false })
    }
  })

  it("keeps a local workspace listed by the local backend exactly as before", async () => {
    await refreshWorkspaceList(undefined, { fetchWorkspaces: async () => [descriptor("w-kept")] })
    try {
      const kept = instances().get("w-kept")
      assert.equal(kept?.folder, "/repo")
      assert.equal(kept && ("backendId" in kept), false)
    } finally {
      removeInstance("w-kept", { authoritative: false })
    }
  })

  it("keeps Missions and preview state separate for the same folder and session on two backends", async (t) => {
    let token = 0
    t.mock.method(serverApi, "createPreview", async ({ sessionId, url }: { sessionId: string; url: string }) => ({
      token: String(++token), sessionId, targetUrl: url, proxyUrl: "/previews/fixture", createdAt: "",
    }))
    t.mock.method(serverApi, "deletePreview", async () => {})
    const local = projectScope({ folder: "/view-repo" }), lab = projectScope({ folder: "/view-repo", backendId: "lab" })
    updateMissionProjectView(local, { selected: "local-mission" })
    updateMissionProjectView(lab, { selected: "lab-mission" })
    const first = await openSessionPreview("same-session", "https://local.example/", local)
    const second = await openSessionPreview("same-session", "https://lab.example/", lab)
    try {
      assert.equal(missionProjectView(local).selected, "local-mission")
      assert.equal(missionProjectView(lab).selected, "lab-mission")
      assert.notEqual(first.storageKey, second.storageKey)
      showSessionChatFor("same-session", lab)
      assert.equal(getSessionPreview("same-session", local)?.mode, "preview")
      assert.equal(getSessionPreview("same-session", lab)?.mode, "chat")
    } finally {
      await closeSessionPreview(first.storageKey)
      await closeSessionPreview(second.storageKey)
    }
  })
})
