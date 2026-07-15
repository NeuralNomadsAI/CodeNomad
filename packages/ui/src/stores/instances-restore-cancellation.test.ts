import assert from "node:assert/strict"
import { it } from "node:test"

import { serverApi } from "../lib/api-client.ts"
import { cancelRestoreCreationRequest } from "./instances.ts"

it("retries pre-response restore cancellation without SSE correlation", async () => {
  const originalCancel = serverApi.cancelWorkspaceCreation
  let calls = 0
  serverApi.cancelWorkspaceCreation = async () => {
    if (++calls === 1) throw new Error("temporary cancellation failure")
  }

  try {
    await cancelRestoreCreationRequest(undefined, "pre-response-request")
    assert.equal(calls, 2)
  } finally {
    serverApi.cancelWorkspaceCreation = originalCancel
  }
})
