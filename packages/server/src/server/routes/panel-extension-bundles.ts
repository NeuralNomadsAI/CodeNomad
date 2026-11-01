import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { PanelExtensionStore } from "../../panel-extensions/store"
import type { IntegrationCatalogSource } from "../../opencode/integrations/catalog"
import type { IntegrationsReader } from "../../opencode/integrations/integrations"
import type { IntegrationAttachments } from "../../opencode/integrations/attachments"
import { bundlesCatalogResultSchema, bundlesStateHostResultSchema, bundlesHostsResultSchema, bundlesHostsInputSchema, bundlesSessionSchema,
  type BundlesStateResult } from "../../panel-extensions/bundles-contract"
import { readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import { createPanelExtensionRoute, PanelRouteRefused, type PanelRouteContext } from "./panel-extension-route"
import { BundlesBudget } from "../../panel-extensions/bundles-budget"

export { BUNDLES_READS_PER_MINUTE, BUNDLES_RATE_WINDOW_MS } from "../../panel-extensions/bundles-budget"
export interface PanelExtensionBundlesDeps {
  store: PanelExtensionStore
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceConnection" | "ownsLocation">
  catalog: Pick<IntegrationCatalogSource, "read">
  integrations: Pick<IntegrationsReader, "read">
  attachments: Pick<IntegrationAttachments, "hosts" | "bindingRead">
  now?: () => number
  routeBudgetMs?: number
  budget?: BundlesBudget
}

/** Fixed read-only facade over the shared native services; no iframe-selected native authority. */
export function registerPanelExtensionBundlesRoutes(app: FastifyInstance, deps: PanelExtensionBundlesDeps) {
  const route = createPanelExtensionRoute(app, deps), manager = deps.workspaceManager
  const budget = deps.budget ?? new BundlesBudget(deps.now)
  const admit = (id: string) => {
    if (!budget.take(id, "read")) throw new PanelRouteRefused(429)
  }
  const owned = async (instanceId: string, sessionID: string, context: PanelRouteContext) => {
    const connection = await manager.getSharedServiceConnection(instanceId)
    if (!connection) throw new PanelRouteRefused(503)
    context.pin(connection)
    const session = async () => {
      context.signal.throwIfAborted(); connection.assertCurrent()
      const value = await connection.client.session.get({ sessionID }, { signal: context.signal })
      const location = readLocationRef(value.location)
      if (value.id !== sessionID || !await manager.ownsLocation(instanceId, location, connection.client, context.signal)) throw new PanelRouteRefused(403)
      context.signal.throwIfAborted(); connection.assertCurrent()
      return location
    }
    const location = await session()
    context.fence(`session:${sessionID}`, async () => { if (!sameLocation(await session(), location)) throw new PanelRouteRefused(409) })
    return location
  }
  const shape = { sessionID: bundlesSessionSchema }
  route("bundles/catalog", "bundles.read", shape, 4096, async (input, context) => {
    admit(context.id)
    await owned(input.instanceId, input.sessionID, context)
    const catalog = await deps.catalog.read()
    context.signal.throwIfAborted()
    return bundlesCatalogResultSchema.parse({ state: catalog.state, fetchedAt: catalog.fetchedAt,
      integrations: catalog.catalog.integrations.map(entry => ({ id: entry.id, displayName: entry.displayName, family: entry.family,
        summary: Object.fromEntries(Object.entries(entry.summary)), app: { name: entry.app.name, versions: entry.app.versions },
        docs: entry.docs, catalogStatus: entry.status })) })
  })
  route("bundles/state", "bundles.read", shape, 4096, async (input, context) => {
    admit(context.id)
    const location = await owned(input.instanceId, input.sessionID, context)
    const result = await deps.integrations.read(input.instanceId, location, context.signal)
    if (!sameLocation(result.location, location)) throw new PanelRouteRefused(409)
    const integrations: BundlesStateResult["integrations"] = []
    // Sequential binding reads keep total native concurrency within the existing four-call bound.
    for (const item of result.integrations) {
      context.signal.throwIfAborted()
      const status = item.status
      const common = { id: item.id, configured: item.configured, scopes: item.scopes.map(scope => scope),
         activation: { global: item.activation.global, project: item.activation.project, effective: item.activation.effective },
         ...(item.plugin ? { plugin: { declared: item.plugin.declared, runtime: item.plugin.runtime } } : {}),
        version: item.version, outdated: item.outdated, state: item.state }
      const statusCommon = status ? { version: status.version,
        notices: status.notices?.filter((notice): notice is "legacy_install" => notice === "legacy_install") } : undefined
      if (item.family === "native") {
        const binding = await deps.attachments.bindingRead(input.instanceId, item.id, location, { sessionID: input.sessionID }, context.signal)
        const attachment = binding.state === "attached" ? { state: "attached" as const, label: binding.label } : { state: binding.state }
        integrations.push({ ...common, family: "native", attachment, ...(status && statusCommon ? { status: { ...statusCommon,
          ...(status.host ? { host: { state: status.host.state, partVersion: status.host.partVersion, expectedRange: status.host.expectedRange,
            appVersion: status.host.appVersion, action: status.host.action } } : {}),
          ...(status.connection ? { connection: { offers: status.connection.offers } } : {}),
        } } : {}) })
      } else {
        integrations.push({ ...common, family: item.family, ...(status && statusCommon ? { status: { ...statusCommon,
          ...(status.connection ? { connection: { state: status.connection.state } } : {}),
        } } : {}) })
      }
    }
    return bundlesStateHostResultSchema.parse({ catalog: { state: result.catalog.state, fetchedAt: result.catalog.fetchedAt }, integrations,
      tracking: result.tracking })
  })
  route("bundles/hosts", "bundles.read", { ...shape, ...bundlesHostsInputSchema.shape }, 4096, async (input, context) => {
    admit(context.id)
    const location = await owned(input.instanceId, input.sessionID, context)
    const hosts = await deps.attachments.hosts(input.instanceId, input.integration, location, context.signal)
    return bundlesHostsResultSchema.parse({ offers: hosts.offers.map(offer => ({ offerID: offer.offerID, label: offer.label,
      document: offer.document, appVersion: offer.appVersion, protocol: offer.protocol })) })
  })
}
