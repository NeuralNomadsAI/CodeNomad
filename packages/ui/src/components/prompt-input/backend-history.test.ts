import assert from "node:assert/strict"
import { it } from "node:test"
import { createRoot } from "solid-js"
import { backendScoped, parseInstanceKey } from "../../lib/backend-identity"
import { serverApi } from "../../lib/api-client"
import { usePromptState } from "./usePromptState"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

it("the real prompt hook preserves the exact local history key and isolates another backend's history and drafts", async t => {
  const folder = "C:\\Exact\\History\\", reads: string[] = [], writes: string[] = []
  t.mock.method(serverApi, "readInstanceData", async (key: string) => {
    reads.push(key)
    return { messageHistory: key === folder ? ["persisted local entry"] : [], agentModelSelections: {} }
  })
  t.mock.method(serverApi, "writeInstanceData", async (key: string) => { writes.push(key) })
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
