import assert from "node:assert/strict"
import { it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { cancelRestoreCreation } from "./restore-creation-cancellation.ts"

it("retries pre-response restore cancellation without SSE correlation", async () => {
  const originalCancel = serverApi.cancelWorkspaceCreation
  let calls = 0
  serverApi.cancelWorkspaceCreation = async () => {
    if (++calls === 1) throw new Error("temporary cancellation failure")
  }

  try {
    await cancelRestoreCreation("pre-response-request")
    assert.equal(calls, 2)
  } finally {
    serverApi.cancelWorkspaceCreation = originalCancel
  }
})
