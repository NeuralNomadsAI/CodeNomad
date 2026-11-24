import assert from "node:assert/strict"
import { it } from "node:test"
import { OpenCode } from "@opencode/client"
import { sdkManager } from "../lib/sdk-manager"
import { applyOpenCodeDataEvent, destroyOpenCodeData, getOpenCodeInstanceGeneration } from "./opencode-data"

it("reconnect fences transcript authority without the projection launching duplicate catalogue HTTP reads", async () => {
  const id = "projection-network-isolation"
  const requests: string[] = []
  const client = OpenCode.make({ baseUrl: "http://fixture", fetch: async (input) => {
    requests.push(String(input))
    return Response.json({})
  } })
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  try {
    const generation = getOpenCodeInstanceGeneration(id)
    for (const type of ["server.connected", "skill.updated", "shell.created", "project.updated", "provider.updated"]) {
      applyOpenCodeDataEvent(id, "/repo", { id: type, type, created: 1, location: { directory: "/repo" }, data: {} } as any)
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.ok(getOpenCodeInstanceGeneration(id) > generation)
    assert.deepEqual(requests, [])
  } finally {
    destroyOpenCodeData(id)
    sdkManager.destroyClientsForInstance(id)
  }
})
