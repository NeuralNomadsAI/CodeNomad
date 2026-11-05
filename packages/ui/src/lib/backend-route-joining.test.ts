import assert from "node:assert/strict"
import { test } from "node:test"
import { createBackendClient } from "./backend-client"
import { createPanelExtensionsApi } from "./panel-extensions-api"
import { toolImageSource } from "./tool-content"
import { SDKManager } from "./sdk-manager"
import { fetchIntegrations, fetchIntegrationBinding, installIntegration, integrationAttachmentRequest } from "./integrations-api"

const bases = ["https://b.invalid", "https://b.invalid/", "https://b.invalid/tenant", "https://b.invalid/tenant/"]
const signal = () => new AbortController().signal
const image = { type: "file" as const, mime: "image/png", uri: `/api/workspaces/w/session-media/s/m/0/0/${"a".repeat(64)}` }

for (const baseUrl of bases) {
  test(`panel extension API and API4 resolve from the origin: ${baseUrl}`, async () => {
    const requests: string[] = []
    const client = createBackendClient({ id: "b", baseUrl, fetcher: async (input, init) => {
      requests.push(String(input))
      assert.equal(init?.credentials, "include")
      return Response.json({})
    } })
    const { panelExtensionsApi: api, panelExtensionsApi4: api4 } = createPanelExtensionsApi(client)
    await api.list()
    await api.catalog(true, signal())
    await api.panel("w", "a/b", "digest", signal())
    await api4.preferencesGet({ instanceId: "w", id: "a/b", digest: "digest" }, signal())
    assert.deepEqual(requests, [
      "https://b.invalid/api/panel-extensions",
      "https://b.invalid/api/panel-extensions/catalog?refresh=true",
      "https://b.invalid/api/panel-extensions/a%2Fb/panel?instanceId=w&digest=digest",
      "https://b.invalid/api/panel-extensions/a%2Fb/preferencesGet",
    ])
  })

  test(`images and a directly constructed SDK manager share the route resolver: ${baseUrl}`, async () => {
    const requests: string[] = []
    const client = createBackendClient({ id: "b", baseUrl, fetcher: async input => {
      requests.push(String(input))
      return Response.json({})
    } })
    assert.equal(toolImageSource(image, baseUrl), `https://b.invalid${image.uri}`)
    assert.equal(toolImageSource(image, client), `https://b.invalid${image.uri}`)
    await new SDKManager(client).createClient("w", "workspaces//w/instance/").session.prompt({ sessionID: "s", text: "fixture" })
    assert.deepEqual(requests, ["https://b.invalid/workspaces/w/instance/api/session/s/prompt"])
  })

  test(`audited auth, integrations, storage, meta and Mission routes share the origin: ${baseUrl}`, async () => {
    const requests: string[] = []
    const client = createBackendClient({ id: "b", baseUrl, fetcher: async input => {
      const url = String(input)
      requests.push(url)
      const path = new URL(url).pathname
      if (path.endsWith("/auth/status")) return Response.json({ authenticated: true })
      if (path.endsWith("/integrations")) return Response.json({ integrations: [], catalog: { state: "fresh" } })
      if (path.endsWith("/binding")) return Response.json({ state: "none" })
      if (path.endsWith("/install")) return Response.json({ scope: "global", spec: "fixture", reloadPending: true })
      if (path.includes("/missions")) return Response.json({ mission: { id: "m" } })
      return Response.json({})
    } })
    await client.auth.check()
    await client.meta.getServerMeta()
    await client.storage.loadConfigOwner("ui")
    await fetchIntegrations("w", "/repo", signal(), client)
    await fetchIntegrationBinding({ instanceId: "w", integrationId: "addon", directory: "/repo", sessionID: "s" }, signal(), client)
    await installIntegration("w", "/repo", "addon", "global", signal(), client)
    await integrationAttachmentRequest("w", "/repo", "addon", "hosts", signal(), undefined, client)
    await client.api.createMission("w", { objective: "fixture", template: "custom", requestId: "create" })
    await client.api.controlMission("w", "m", { action: "pause", expectedRevision: 1, requestId: "pause" })
    await client.api.deleteMission("w", "m", { expectedRevision: 1, requestId: "delete" })
    assert.deepEqual(requests, [
      "/api/auth/status", "/api/meta", "/api/storage/config/ui",
      "/api/workspaces/w/integrations?directory=%2Frepo",
      "/api/workspaces/w/integrations/addon/binding?directory=%2Frepo&sessionID=s",
      "/api/workspaces/w/integrations/addon/install?directory=%2Frepo",
      "/api/workspaces/w/integrations/addon/hosts?directory=%2Frepo",
      "/api/workspaces/w/missions", "/api/workspaces/w/missions/m/control", "/api/workspaces/w/missions/m",
    ].map(path => `https://b.invalid${path}`))
  })
}
