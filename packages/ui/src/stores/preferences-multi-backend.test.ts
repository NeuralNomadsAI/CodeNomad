import assert from "node:assert/strict"
import test from "node:test"
import { serverApi } from "../lib/api-client"
import { registerBackendClient, createBackendClient } from "../lib/backend-client"
import { backendEvents } from "../lib/backend-events"

let settings: Record<string, unknown> = {}
serverApi.fetchConfigOwner = async () => ({ settings }) as never
serverApi.fetchStateOwner = async () => ({}) as never
serverApi.patchConfigOwner = async (_owner, patch) => {
  settings = { ...settings, ...(patch as { settings: object }).settings }
  return { settings } as never
}
const { preferencesForBackend } = await import("./preferences")

test("host multiBackend defaults on, strictly normalizes edits and owns remote settings", async () => {
  const host = preferencesForBackend("local")
  await host.ensureLoaded()
  assert.equal(host.preferences().multiBackend, true)
  const client = createBackendClient({ id: "other", baseUrl: "http://unused.test",
    fetcher: async input => Response.json(String(input).includes("/storage/config/") ? { settings: { multiBackend: false } } : {}) })
  const remove = registerBackendClient(client), detach = backendEvents.attach(client.id, client.events)
  try {
    const remote = preferencesForBackend(client.id)
    await remote.ensureLoaded()
    assert.equal(remote.preferences().multiBackend, true)
    for (const value of [undefined, false, "true", 1, null, {}, [], true]) {
      assert.equal(await remote.updatePreferences({ multiBackend: value } as never), true)
      const expected = value === undefined || value === true
      assert.equal(host.preferences().multiBackend, expected)
      assert.equal(remote.preferences().multiBackend, expected)
      assert.equal(settings.multiBackend, expected)
    }
  } finally { detach(); client.events.dispose(); remove() }
})
