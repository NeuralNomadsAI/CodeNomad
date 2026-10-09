import assert from "node:assert/strict"
import { test } from "node:test"
import { serverApi } from "../lib/api-client"

// Preferences load when their module is imported, so stub storage first.
const patches: any[] = []
let state: any = { recentFolders: [{ path: "D:\\Client", lastAccessed: 2 }, { path: "D:\\Other", lastAccessed: 1 }] }
serverApi.fetchConfigOwner = async () => ({}) as any
serverApi.fetchStateOwner = async () => state
serverApi.patchStateOwner = async (_owner, patch: any) => { patches.push(patch); state = { ...state, ...patch }; return state }
const { addInstance, instances, removeInstance } = await import("./instances")
const { renameProject } = await import("./project-names")

test("renaming a project names its recent folder and every open tab of that folder only", async () => {
  const tabs = [["rename-a", "D:\\Client"], ["rename-b", "d:/client/"], ["rename-c", "D:\\Other"]] as const
  for (const [id, folder] of tabs) addInstance({ id, folder, port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
  try {
    await renameProject("D:\\Client", "Client A")
    assert.deepEqual(tabs.map(([id]) => instances().get(id)?.projectName), ["Client A", "Client A", undefined])
    assert.deepEqual(patches.at(-1).recentFolders.map((folder: any) => folder.projectName), ["Client A", undefined])
  } finally {
    for (const [id] of tabs) removeInstance(id, { authoritative: false })
  }
})
