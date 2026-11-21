import assert from "node:assert/strict"
import { it } from "node:test"
import { createRoot } from "solid-js"
import { backendScoped, parseInstanceKey } from "../../lib/backend-identity"
import { serverApi } from "../../lib/api-client"
import { usePromptState } from "./usePromptState"
import { backends, createBackendClient, type BackendClient } from "../../lib/backend-client"
import { backendEvents } from "../../lib/backend-events"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

it("the real prompt hook preserves the exact local history key and isolates another backend's history and drafts", async t => {
  const folder = "C:\\Exact\\History\\", reads: string[] = [], writes: string[] = []
  t.mock.method(serverApi, "readInstanceData", async (key: string) => {
    reads.push(key)
    return { messageHistory: key === folder ? ["persisted local entry"] : [], agentModelSelections: {} }
  })
  t.mock.method(serverApi, "writeInstanceData", async (key: string) => { writes.push(key) })
  const backend = createBackendClient({ id: "lab", baseUrl: "https://lab.invalid" })
  ;(backends as Map<string, BackendClient>).set("lab", backend)
  const detach = backendEvents.attach("lab", backend.events)
  t.mock.method(backend.api, "readInstanceData", (key: string) => serverApi.readInstanceData(backendScoped("lab", key)))
  t.mock.method(backend.api, "writeInstanceData", (key: string, data: Parameters<typeof serverApi.writeInstanceData>[1]) => serverApi.writeInstanceData(backendScoped("lab", key), data))
  t.after(() => { detach(); backend.events.dispose(); (backends as Map<string, BackendClient>).delete("lab") })
  const mount = (instanceId: string) => createRoot(dispose => ({ dispose, state: usePromptState({
    instanceId: () => instanceId, sessionId: () => "same-session", instanceFolder: () => folder,
    historyKey: () => backendScoped(parseInstanceKey(instanceId).backendId, folder),
  }) }))
  const local = mount("w1"), remote = mount("lab~w1")
  try {
    for (let i = 0; i < 30 && reads.length < 2; i++) await tick()
    await tick()
    assert.deepEqual(reads.sort(), [folder, `lab~${folder}`].sort())
    assert.deepEqual(local.state.history(), ["persisted local entry"])
    assert.deepEqual(remote.state.history(), [])
    local.state.setPrompt("local draft")
    remote.state.setPrompt("remote draft")
    await remote.state.recordHistoryEntry("remote entry")
    await local.state.recordHistoryEntry("local entry")
    assert.deepEqual(writes, [`lab~${folder}`, folder])
    const nextLocal = mount("w1"), nextRemote = mount("lab~w1")
    try {
      await tick(); await tick()
      assert.deepEqual(nextLocal.state.history(), ["local entry", "persisted local entry"])
      assert.deepEqual(nextRemote.state.history(), ["remote entry"])
      assert.equal(nextLocal.state.prompt(), "local draft")
      assert.equal(nextRemote.state.prompt(), "remote draft")
    } finally { nextLocal.dispose(); nextRemote.dispose() }
  } finally { local.dispose(); remote.dispose() }
})
