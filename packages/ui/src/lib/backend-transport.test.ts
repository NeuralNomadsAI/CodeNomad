import assert from "node:assert/strict"
import { test } from "node:test"
import { createBackendClient } from "./backend-client"
import { createBackendTransport } from "./backend-transport"

test("remote HTTP, events and SDK routes resolve from the origin with or without a trailing slash", async () => {
  // CodeNomad routes are root-relative: a base's path prefix is discarded by
  // HTTP, default SSE and SDK alike, rather than treated as a reverse-proxy mount.
  for (const baseUrl of ["https://b.invalid", "https://b.invalid/", "https://b.invalid/tenant", "https://b.invalid/tenant/", "HTTPS://b.invalid/"]) {
    const requests: string[] = []
    const client = createBackendClient({
      id: "b", baseUrl,
      fetcher: async input => {
        requests.push(String(input))
        return Response.json({})
      },
    })
    assert.equal(client.url("/api/meta"), "https://b.invalid/api/meta", baseUrl)
    assert.equal(client.eventsUrl, "https://b.invalid/api/events", baseUrl)
    await client.api.fetchServerMeta()
    await client.sdk.createClient("ws", "/workspaces/ws/instance").session.prompt({ sessionID: "owned", text: "fixture" })
    assert.deepEqual(requests, [
      "https://b.invalid/api/meta",
      "https://b.invalid/workspaces/ws/instance/api/session/owned/prompt",
    ], baseUrl)
    assert.equal(createBackendTransport({ id: "b", baseUrl, eventsUrl: "api/events?custom=1" }).eventsUrl,
      "https://b.invalid/api/events?custom=1")
    assert.equal(createBackendTransport({ id: "b", baseUrl, eventsUrl: "https://events.invalid/custom" }).eventsUrl,
      "https://events.invalid/custom")
  }
})

test("local absent and relative bases preserve event URLs character for character", () => {
  for (const baseUrl of [undefined, "", "/relay", "/relay/"]) {
    for (const eventsUrl of [undefined, "/api/events", "api/events?custom=1", "https://events.invalid/custom"]) {
      const path = eventsUrl ?? "/api/events"
      const expected = path.startsWith("https://") || !baseUrl ? path
        : `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`
      assert.equal(createBackendTransport({ id: "local", baseUrl, eventsUrl }).eventsUrl, expected)
    }
  }
})
