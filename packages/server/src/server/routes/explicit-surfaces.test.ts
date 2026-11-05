import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { EventBus } from "../../events/bus"
import { WorkspaceManager } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { PluginControls } from "../../opencode/plugin-controls"
import { PluginSources } from "../../opencode/plugin-sources"
import { ImageSettings } from "../../opencode/image-settings"
import { WebSearchSettings } from "../../opencode/websearch-settings"
import { IntegrationsReader } from "../../opencode/integrations/integrations"
import { ServiceUsage } from "../../opencode/service-usage"
import { SubagentDepthSettings } from "../../opencode/subagent-depth-settings"
import { registerSessionPruningRoutes } from "./session-pruning"
import { registerSessionGoalRoute } from "./session-goal"
import { registerImagesConversationRoute, resolveImagesConversationAt } from "./images-conversation"
import { registerPanelExtensionApi4Routes } from "./panel-extension-api4"
import { registerPanelExtensionAssetRoutes } from "./panel-extension-assets"
import { registerProviderAccountsRoutes } from "./provider-accounts"
import { registerUsageRoutes } from "./usage"
import { registerServiceUsageRoutes } from "./service-usage"
import { registerPluginControlRoutes } from "./plugin-controls"
import { registerPluginSourceRoutes } from "./plugin-sources"
import { registerImageSettingsRoutes } from "./image-settings"
import { registerWebSearchSettingsRoutes } from "./websearch-settings"
import { registerIntegrationRoutes } from "./integrations"
import { registerSubagentDepthSettingsRoutes } from "./subagent-depth-settings"
import { historyDirectories, ownedHistorySessions } from "./session-history-scope"
import type { ServerCapability } from "../../opencode/servers/capabilities"

test("explicit surfaces use real workspace admission before any local lookup, acquisition, RPC or exclusion", async t => {
  const effects: string[] = []
  const forbidden = (name: string) => () => { effects.push(name); throw new Error(`Unexpected ${name}`) }
  const logger = pino({ level: "silent" }), directory = "/same/project"
  // A pre-admitted in-memory transport supplies attachment proof only. The real
  // manager and ExplicitWorkspace own the capability decision below.
  const connection = { serverId: "explicit", generation: 1, endpoint: { url: "http://fixture.invalid" },
    assertCurrent() {}, fetch: async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === "/api/location") return Response.json({ directory, project: { id: "p" } })
      if (url.pathname === "/api/fs/list") return Response.json({ location: { directory }, data: [] })
      return forbidden("unexpected transport")()
    } }
  const connections = { retainProject: () => ({ acquire: async () => connection, published() {}, release() {} }),
    existingForServer: (serverId: string) => serverId === connection.serverId ? connection : undefined,
    dispose: async () => {} }
  const manager = new WorkspaceManager({ rootDir: "C:/unused", logger, eventBus: new EventBus(),
    binaryResolver: { resolveDefault: forbidden("binary") } as never,
    settings: { getOpenCodeServerConnections: () => connections, getOwner: forbidden("settings"),
      disposeOpenCodeServers: async () => {} } as never,
    sharedService: { endpoint: forbidden("endpoint"), client: forbidden("client"), headers: forbidden("headers"),
      validateLocation: forbidden("location"), subscribe: forbidden("subscribe"), shutdown: async () => {} },
  })
  const workspace = (await manager.create(directory, undefined, { serverId: "explicit" })).workspace
  const id = workspace.id
  assert.doesNotThrow(() => manager.requireWorkspaceCapability(id, "chat"))
  assert.doesNotThrow(() => manager.requireWorkspaceCapability(id, "media"))
  for (const method of ["get", "getServiceLocation", "getSharedServiceClient", "getSharedServiceConnection", "desktopPluginsReady",
    "getWorktrees", "getWorktreeIdentityForPath", "ownsLocation", "getServiceDirectoryForPath", "getServicePathStyle",
    "getServiceWslDistro", "getHostPathForServicePath", "getSessionEnvironment"] as const) {
    t.mock.method(manager, method, forbidden(method))
  }
  const fence = new WorktreeDeletionFence()
  t.mock.method(fence, "enter", forbidden("deletion fence"))
  const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: fence, logger })
  const sources = new PluginSources({ documents: controls, logger, catalog: { read: forbidden("catalog") } })
  const images = new ImageSettings(controls, manager), websearch = new WebSearchSettings(controls)
  const integrations = new IntegrationsReader({ workspaceManager: manager, controls, catalog: { read: forbidden("catalog") } })
  const usage = new ServiceUsage(manager)
  const imageDeps = { workspaceManager: manager, worktreeDeletionFence: fence, excludeDesignFolder: forbidden("exclude write") }
  const app = Fastify()
  registerSessionPruningRoutes(app, imageDeps)
  registerSessionGoalRoute(app, imageDeps)
  registerImagesConversationRoute(app, imageDeps)
  registerPanelExtensionApi4Routes(app, { ...imageDeps, store: { authorize: forbidden("panel consent") } as never,
    imageSettings: images, checkDesignFolderExclusion: forbidden("exclude read") })
  registerPanelExtensionAssetRoutes(app, { workspaceManager: manager, store: { authorize: forbidden("asset consent") } as never })
  registerProviderAccountsRoutes(app, { ...imageDeps, accounts: { snapshot: forbidden("credentials"), setEnabled: forbidden("policy") } as never })
  registerUsageRoutes(app, imageDeps)
  registerServiceUsageRoutes(app, usage)
  registerPluginControlRoutes(app, { controls })
  registerPluginSourceRoutes(app, { sources })
  registerImageSettingsRoutes(app, images)
  registerWebSearchSettingsRoutes(app, websearch)
  registerIntegrationRoutes(app, { integrations })
  registerSubagentDepthSettingsRoutes(app, new SubagentDepthSettings(controls, manager))
  t.after(async () => { await app.close(); t.mock.restoreAll(); await manager.shutdown() })
  const base = `/api/workspaces/${id}`, location = { directory }, revision = "a".repeat(64)
  const cases: Array<[string, string, unknown, ServerCapability]> = [
    ["POST", `${base}/session-history/query`, {}, "historyEnrichment"],
    ["POST", `${base}/session-history/query`, { sessionID: "ses_s", purpose: "prune" }, "historyEnrichment"],
    ["POST", `${base}/session-history/ranked`, { version: 1, query: "needle" }, "historyEnrichment"],
    ["POST", `${base}/session-history/window`, { sessionID: "ses_s", target: { kind: "latest" } }, "historyEnrichment"],
    ["POST", `${base}/session-history/outline`, { sessionID: "ses_s" }, "historyEnrichment"],
    ["POST", `${base}/session-history/outlinePreview`, { sessionID: "ses_s", messageIDs: ["m"] }, "historyEnrichment"],
    ["POST", `${base}/session-history/prune`, { sessionID: "ses_s", candidates: [{ messageID: "m", revision, toolCount: 1, reasoningCount: 0 }] }, "sessionPruning"],
    ["POST", `${base}/session-pruning/preview`, { sessionID: "ses_s", messageID: "m" }, "sessionPruning"],
    ["POST", `${base}/session-pruning/prune`, { sessionID: "ses_s", messageID: "m", revision, indexes: [0] }, "sessionPruning"],
    ["GET", `${base}/sessions/ses_s/goal`, undefined, "historyEnrichment"],
    ...["lookup", "open", "new"].map(mode => ["POST", `${base}/images-conversation`, { directory, mode }, "integratedImages"] as typeof cases[number]),
    ["GET", `${base}/provider-accounts/openai?directory=${directory}`, undefined, "executionSettings"],
    ["PUT", `${base}/provider-accounts/openai`, { directory, enabled: true }, "executionSettings"],
    ["GET", `${base}/service-usage/owner`, undefined, "executionSettings"],
    ["GET", `${base}/service-usage/cache?timezone=UTC`, undefined, "executionSettings"],
    ["GET", `${base}/service-usage?from=1&to=2&timezone=UTC`, undefined, "executionSettings"],
    ["PATCH", `${base}/plugin-controls`, { location, pluginId: "example.plugin", scope: "global", enabled: true }, "executionSettings"],
    ["POST", `${base}/plugin-sources`, { location, scope: "global", spec: "example-plugin@1" }, "executionSettings"],
    ["DELETE", `${base}/plugin-sources`, { location, scope: "global", target: "example-plugin@1", entryIndex: 0, expectedRevision: revision }, "executionSettings"],
    ["GET", `${base}/image-settings?directory=${directory}`, undefined, "executionSettings"],
    ["PUT", `${base}/image-settings`, { location, generation: false }, "executionSettings"],
    ["GET", `${base}/websearch-settings?directory=${directory}`, undefined, "executionSettings"],
    ["PUT", `${base}/websearch-settings`, { location, scope: "project", provider: false }, "executionSettings"],
    ["GET", `${base}/subagent-depth?directory=${directory}`, undefined, "executionSettings"],
    ["PUT", `${base}/subagent-depth`, { location, depth: 1, expectation: revision }, "executionSettings"],
    ["POST", "/api/panel-extensions/example.assets/assets", { instanceId: id, digest: revision, sessionID: "ses_s" }, "integratedImages"],
    ["POST", "/api/panel-extensions/example.assets/assetRead", { instanceId: id, digest: revision, sessionID: "ses_s",
      target: { messageID: "m", part: 0, index: 0, digest: revision } }, "integratedImages"],
    ...["images", "imageRead", "imagesStatus", "prefillReferences", "conversationStatus", "conversationOpen", "conversationNew"].map(method => {
      const target = { messageID: "m", part: 0, index: 0, digest: revision }
      const fields = method === "images" || method === "imagesStatus" ? { sessionID: "ses_s" }
        : method === "imageRead" ? { sessionID: "ses_s", target }
        : method === "prefillReferences" ? { sessionID: "ses_s", targets: [target] }
        : method === "conversationStatus" ? { directory } : { directory, title: "Images" }
      return ["POST", `/api/panel-extensions/example.design/${method}`, { instanceId: id, digest: revision, ...fields }, "integratedImages"] as typeof cases[number]
    }),
  ]
  for (const [method, url, payload, capability] of cases) {
    const response = await app.inject({ method: method as "POST", url, ...(payload ? { payload } : {}) })
    assert.equal(response.statusCode, 403, `${method} ${url}: ${response.body}`)
    assert.deepEqual(response.json(), { error: "explicit_capability_unavailable", code: "explicit_capability_unavailable", capability, reason: { code: "deferred" } })
    assert.deepEqual(effects, [], `${method} ${url} admitted effects`)
  }
  // The trusted shared guard's missing-workspace status must survive settings
  // error translation, including the Stats owner/cache routes' separate catches.
  for (const [method, url, payload, capability] of cases) {
    const missing = url.replaceAll(id, "missing-workspace")
    const missingPayload = payload ? JSON.parse(JSON.stringify(payload).replaceAll(id, "missing-workspace")) : undefined
    const response = await app.inject({ method: method as "POST", url: missing, ...(missingPayload ? { payload: missingPayload } : {}) })
    assert.equal(response.statusCode, 404, `${method} ${missing}: ${response.body}`)
    if (url.endsWith("/plugin-sources")) assert.deepEqual(response.json(), { error: "Plugin source update refused" })
    else if (capability === "executionSettings") assert.equal(response.json().message ?? response.json().error, "Workspace not found", `${method} ${missing}`)
    assert.deepEqual(effects, [], `${capability} missing workspace admitted effects`)
  }
  const denied = { code: "explicit_capability_unavailable" }
  await assert.rejects(historyDirectories(manager, id, directory), denied)
  await assert.rejects(ownedHistorySessions(manager, id, {} as never, []), denied)
  await assert.rejects(resolveImagesConversationAt(imageDeps, id, directory, { mode: "open" }), denied)
  // Separate preambles must also hold when the shared configuration dependency is replaced.
  const configuration = { readConfigDocuments: forbidden("documents"), editConfigDocument: forbidden("edit") }
  await assert.rejects(new ImageSettings(configuration, manager).read(id, location), denied)
  await assert.rejects(new SubagentDepthSettings(configuration, manager).read(id, location), denied)
  // prototype-1236: usage, the plugin inventory and integrations are admitted (explicit-panels.test.ts).
  // Qualifying images alone must still leave the independent Design boundary closed.
  const requireCapability = manager.requireWorkspaceCapability.bind(manager)
  t.mock.method(manager, "requireWorkspaceCapability", (workspaceId: string, capability: ServerCapability) =>
    capability === "integratedImages" ? new AbortController().signal : requireCapability(workspaceId, capability))
  await assert.rejects(resolveImagesConversationAt(imageDeps, id, directory, { mode: "open" }), { ...denied, capability: "design" })
  const gallery = await app.inject({ method: "POST", url: "/api/panel-extensions/example.design/images",
    payload: { instanceId: id, digest: revision, sessionID: "ses_s" } })
  assert.equal(gallery.statusCode, 403)
  assert.equal(gallery.json().capability, "design")
  assert.deepEqual(effects, [])
})
