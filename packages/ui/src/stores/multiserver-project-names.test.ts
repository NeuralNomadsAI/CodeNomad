import assert from "node:assert/strict"
import { test } from "node:test"
import { serverApi } from "../lib/api-client"

const folder = "D:/same"
let state: any = { recentFolders: [undefined, "A", "B", "orphan"].map(serverId => ({
  path: folder, lastAccessed: 1, ...(serverId ? { serverId } : {}),
})) }
serverApi.fetchConfigOwner = async () => ({}) as any
serverApi.fetchStateOwner = async () => state
serverApi.patchStateOwner = async (_owner, patch: any) => { state = { ...state, ...patch }; return state }
const { addInstance, instances, removeInstance } = await import("./instances")
const { renameProject } = await import("./project-names")
const { uiState } = await import("./preferences")

test("rename updates only the captured server/directory in live occurrences and recent metadata", async () => {
  const targets = [
    { id: "local", folder }, { id: "a1", folder, serverId: "A" }, { id: "a2", folder, serverId: "A" },
    { id: "b", folder, serverId: "B" }, { id: "alias", folder: "d:/same", serverId: "A" },
  ]
  for (const target of targets) addInstance({ ...target, binding: { serverId: target.serverId ?? "local-shared", directory: target.folder },
    port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
  try {
    await renameProject(folder, "Intended A name", "A")
    assert.deepEqual(targets.map(({ id }) => instances().get(id)?.projectName), [undefined, "Intended A name", "Intended A name", undefined, undefined])
    assert.deepEqual(uiState().recentFolders.map(entry => entry.projectName), [undefined, "Intended A name", undefined, undefined])
    await renameProject(folder, "Orphan name", "orphan")
    assert.deepEqual(targets.map(({ id }) => instances().get(id)?.projectName), [undefined, "Intended A name", "Intended A name", undefined, undefined])
    assert.equal(uiState().recentFolders.find(entry => entry.serverId === "orphan")?.projectName, "Orphan name")
    await renameProject(folder, "Local name")
    assert.deepEqual(targets.map(({ id }) => instances().get(id)?.projectName), ["Local name", "Intended A name", "Intended A name", undefined, undefined])
    assert.equal(uiState().recentFolders.find(entry => !entry.serverId)?.projectName, "Local name")
  } finally { targets.forEach(({ id }) => removeInstance(id, { authoritative: false })) }
})
