import { createHash, randomUUID } from "node:crypto"
import type { PluginControlLocation, PluginControlScope } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { locationRequestOptions, readLocationRef, sameLocation } from "../opencode/compatibility/location"
import type { IntegrationCatalogSource } from "../opencode/integrations/catalog"
import { integrationStatusSchema, type IntegrationStatus } from "../opencode/integrations/contract"
import type { IntegrationAttachments } from "../opencode/integrations/attachments"
import { recognizeIntegrations } from "../opencode/integrations/recognition"
import { integrationSourceIdentity } from "../opencode/plugin-source-identity"
import { looksLikePath, readIntegrationStatuses } from "../opencode/integrations/status"
import { NativeMutationUncertainError, type NativeMutationAuthority } from "../opencode/native-mutation-authority"
import { appendPluginControlRule, encodePluginControlOriginal, type PluginControlDocument } from "../opencode/plugin-control-document"
import type { PluginControls } from "../opencode/plugin-controls"
import type { PluginSources } from "../opencode/plugin-sources"
import type { PluginPackages } from "../opencode/plugin-packages"
import { removePluginSourceEntry } from "../opencode/plugin-source-document"
import type { PluginSourceRemoveRequest } from "../plugin-source-types"
import { bundlesHostsResultSchema, bundlesSessionSchema } from "./bundles-contract"
import type { BundlesPrepared, BundlesTarget } from "./bundles-lifecycle"

export type BundlesAction =
  | { action: "install" | "update" | "remove"; integration: string; scope: PluginControlScope }
  | { action: "setActive"; integration: string; scope: PluginControlScope; active: boolean }
  | { action: "installHost"; integration: string }
  | { action: "attach"; integration: string; offerID: string }

/** Captured by the trusted mounted host. Every revalidation checks its live consent and exact native identity. */
export interface BundlesHostContext {
  instanceId: string
  sessionID: string
  location: PluginControlLocation
  connection: ServiceConnection
  authority: NativeMutationAuthority & { readonly signal: AbortSignal }
}
export interface BundlesActionsDeps {
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceConnection">
  catalog: Pick<IntegrationCatalogSource, "read" | "snapshot">
  controls: Pick<PluginControls, "read" | "readConfigDocuments" | "readSourceDocument" | "mutate">
  sources: Pick<PluginSources, "add" | "remove">
  packages: Pick<PluginPackages, "update">
  attachments: Pick<IntegrationAttachments, "assertHostInstallationSupported" | "hosts" | "attach" | "detach" | "installHost">
}

const identities = new WeakMap<ServiceConnection, string>()
function connectionIdentity(connection: ServiceConnection): string {
  let identity = identities.get(connection)
  if (!identity) identities.set(connection, identity = randomUUID())
  return identity
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
function stale(): never { throw new Error("Stale bundles target") }
function documentIdentity(document: PluginControlDocument, updated?: string): string {
  // Windows chmod controls the writable bit; a newly created 0600 host file reads back as 0666.
  const mode = updated !== undefined && process.platform === "win32" && document.writePath.includes("\\")
    ? document.mode & 0o200 ? 0o666 : 0o444 : document.mode
  return JSON.stringify([document.requestedPath, document.writePath, updated === undefined ? document.exists : true,
    mode, digest(updated === undefined ? encodePluginControlOriginal(document) : updated)])
}
function displayText(value: string, fallback: string, max = 120): string {
  const text = [...value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()].slice(0, max).join("")
  return text && !looksLikePath(text) ? text : fallback
}

/** Fixed catalogue operations. Package specs, native targets and sessions are derived only by this builder. */
export class BundlesActions {
  constructor(private readonly deps: BundlesActionsDeps) {}

  /** Admission reads the existing catalogue only; preparation still verifies its complete fresh target. */
  accepts(action: BundlesAction): boolean {
    const catalog = this.deps.catalog.snapshot()
    const entry = catalog.catalog.integrations.find(candidate => candidate.id === action.integration)
    return Boolean(entry && catalog.state !== "unavailable"
      && !(entry.family === "native" && "scope" in action && action.scope === "project")
      && !((action.action === "attach" || action.action === "installHost") && entry.family !== "native"))
  }

  async prepare(input: BundlesHostContext, requested: BundlesAction, outer: AbortSignal): Promise<BundlesPrepared> {
    const context = { ...input, location: Object.freeze({ ...input.location }) }, action = Object.freeze({ ...requested })
    const signal = AbortSignal.any([outer, context.authority.signal])
    this.validate(context, action.integration)
    const scope = "scope" in action ? action.scope : "global"
    if (scope !== "global" && scope !== "project") stale()
    if (action.action === "setActive" && typeof action.active !== "boolean") stale()
    if (action.action === "attach" && !/^[A-Za-z0-9_-]{8,64}$/.test(action.offerID)) stale()
    if (!["install", "update", "remove", "setActive", "installHost", "attach"].includes(action.action)) stale()
    let submitted = false, beforeDocument: string | undefined, afterDocument: string | undefined
    let nativeTarget: string | undefined
    let updateBefore: { version: string | undefined } | undefined
    let beforeHost: NonNullable<IntegrationStatus["host"]> | undefined
    let beforeDeclaration: string | undefined
    let removal: PluginSourceRemoveRequest | undefined, removalSource: string | undefined, removalEntry: unknown
    let requireRemoved = false

    const read = async (readSignal: AbortSignal) => {
      const currentSignal = AbortSignal.any([signal, readSignal])
      if (action.action === "installHost") await this.deps.attachments.assertHostInstallationSupported(context.instanceId)
      await this.authorize(context, currentSignal)
      const catalog = await this.deps.catalog.read({ refresh: false })
      const entry = catalog.catalog.integrations.find(candidate => candidate.id === action.integration)
      if (!entry || catalog.state === "unavailable") stale()
      if (entry.family === "native" && scope !== "global") stale()
      if ((action.action === "attach" || action.action === "installHost") && entry.family !== "native") stale()
      const snapshot = await this.deps.controls.read(context.instanceId, context.location, currentSignal)
      if (!sameLocation(snapshot.location, context.location)) stale()
      const recognition = recognizeIntegrations(catalog.catalog, snapshot).find(candidate => candidate.entry.id === entry.id)!
      if (recognition.ambiguous) stale()
      if (action.action === "install" && !submitted && (recognition.sources.length || recognition.runtime)) stale()
      if (action.action === "setActive" && !recognition.control) stale()
      const documents = await this.deps.controls.readConfigDocuments(context.instanceId, context.location, currentSignal)
      if (!sameLocation(documents.location, context.location)) stale()
      const targetDocument = documents.documents.find(candidate => candidate.scope === scope)
      const scopeTarget = snapshot.targets.find(candidate => candidate.scope === scope)
      if (!targetDocument || !scopeTarget || targetDocument.path !== scopeTarget.path) stale()
      const identity = JSON.stringify([targetDocument.path, documentIdentity(targetDocument.document)])
      const writesConfig = action.action === "install" || action.action === "setActive" || action.action === "remove"
      if (beforeDocument === undefined) {
        beforeDocument = identity
        if (writesConfig && action.action !== "remove") {
          const rule = action.action === "install" ? `${entry.package}@${entry.range}` : `${action.action === "setActive" && action.active ? "" : "-"}${entry.plugin}`
          afterDocument = JSON.stringify([targetDocument.path, documentIdentity(targetDocument.document, appendPluginControlRule(targetDocument.document, rule))])
        }
      }
      if (action.action === "remove") {
        const sourceIdentity = (source: typeof recognition.sources[number]) => JSON.stringify([
          source.scope, source.path, source.target, source.entryIndex, source.hasOptions,
        ])
        if (submitted && identity === afterDocument) {
          // Native config discovery may still show the removed source until its watcher catches up.
          // Only that exact stale row or its absence is expected; every other candidate fails closed.
          if (recognition.sources.length > 1 || recognition.sources.some(source => sourceIdentity(source) !== removalSource)) stale()
        } else {
          const [source] = recognition.sources
          if (requireRemoved || recognition.sources.length !== 1 || !source || source.scope !== scope
            || source.path !== scopeTarget.path || !scopeTarget.expectedRevision) stale()
          if (!removal) {
            removal = Object.freeze({ location: context.location, scope, target: source.target, entryIndex: source.entryIndex,
              expectedRevision: scopeTarget.expectedRevision })
            removalSource = sourceIdentity(source)
            removalEntry = structuredClone(targetDocument.document.plugins[source.entryIndex])
            afterDocument = JSON.stringify([targetDocument.path, documentIdentity(targetDocument.document,
              removePluginSourceEntry(targetDocument.document, source.entryIndex, source.target))])
          }
          if (sourceIdentity(source) !== removalSource || scopeTarget.expectedRevision !== removal.expectedRevision) stale()
        }
      }
      // Config writes alone may normalize their exact expected bytes/destination/mode after submission.
      const document = submitted && writesConfig && identity === afterDocument ? beforeDocument : identity
      let runtimeIdentity: unknown, declaration: unknown
      if (removal) declaration = { source: removalSource, entry: removalEntry, revision: removal.expectedRevision }
      const pinsRuntime = action.action === "attach" || action.action === "installHost" || action.action === "update"
      if (pinsRuntime || action.action === "setActive" && entry.family === "native") {
        const source = recognition.sources[0]
        if (recognition.sources.length !== 1 || !source || source.scope !== scope || !source.path) stale()
        const actual = source.path === targetDocument.path ? { ...targetDocument, location: documents.location }
          : await this.deps.controls.readSourceDocument(context.instanceId, context.location, source, currentSignal)
        if (!sameLocation(actual.location, context.location) || actual.scope !== scope || actual.path !== source.path) stale()
        const raw = actual.document.plugins[source.entryIndex]
        if ((typeof raw === "string" ? raw : raw?.package) !== source.target) stale()
        let fingerprint = documentIdentity(actual.document)
        beforeDeclaration ??= fingerprint
        if (submitted && writesConfig && identity === afterDocument
          && actual.document.writePath === targetDocument.document.writePath && actual.document.mode === targetDocument.document.mode
          && encodePluginControlOriginal(actual.document).equals(encodePluginControlOriginal(targetDocument.document))) fingerprint = beforeDeclaration
        declaration = { path: source.path, scope: source.scope, target: source.target, entryIndex: source.entryIndex,
          hasOptions: source.hasOptions, fingerprint }
      }
      if (pinsRuntime) {
        const runtime = recognition.runtime, source = recognition.sources[0]!
        if (snapshot.runtime.filter(candidate => candidate.id === entry.plugin).length !== 1
          || !runtime || runtime.id !== entry.plugin || (runtime.source.type !== "package" && runtime.source.type !== "local")
          || source.pluginId !== entry.plugin) stale()
        if (runtime.source.type === "package" && source.target !== runtime.source.target) stale()
        let version = runtime.source.type === "package" ? runtime.source.version : undefined
        if (action.action === "update") {
          updateBefore ??= { version }
          // Native update owns version resolution, while declaration, target and source type remain immutable.
          if (submitted && version !== updateBefore.version) {
            if (!integrationStatusSchema.shape.integration.shape.version.safeParse(version).success) stale()
            version = updateBefore.version
          }
        }
        runtimeIdentity = { id: runtime.id, source: runtime.source.type === "package"
          ? { type: "package", target: runtime.source.target, version } : runtime.source, provenance: source }
      }
      let runtimeTarget: string | undefined
      if (action.action === "update") {
        const runtime = recognition.runtime
        if (!runtime || runtime.source.type !== "package") stale()
        runtimeTarget = runtime.source.target
        if (nativeTarget === undefined) nativeTarget = runtimeTarget
      }
      if ((action.action === "installHost" || action.action === "attach") && recognition.runtime?.state.status !== "active") stale()
      let hostIntent: unknown, hostVersion: string | undefined
      if (action.action === "installHost") {
        const [result] = await readIntegrationStatuses([recognition], async (rpcID, method, nativeSignal) => {
          await this.authorize(context, nativeSignal)
          const response = await context.connection.client.rpc.call({ rpcID, method, input: {}, location: { directory: context.location.directory } },
            { ...locationRequestOptions(context.location), signal: nativeSignal })
          return response.output
        }, { signal: currentSignal })
        await this.authorize(context, currentSignal)
        if (result?.state !== "ok" || !result.status.host) stale()
        const host = result.status.host
        hostVersion = result.status.integration.version
        if (!submitted) {
          // Absence is explicit inspection authority; an update also names the installed part.
          if (!(host.state === "absent" && host.action === "install" && host.partVersion === undefined
            || host.state === "outdated" && host.action === "update" && host.partVersion !== undefined)) stale()
          beforeHost ??= { ...host }
        }
        // Installation may make the exact packaged part available, or leave a closed application unknown.
        // Only these expected host effects normalize; marker/package versions and every other binding stay fresh.
        const expectedEffect = submitted && host.action === undefined && host.expectedRange === beforeHost?.expectedRange
          && (host.state === "ok" && host.partVersion === hostVersion
            && (beforeHost?.appVersion === undefined || host.appVersion === beforeHost.appVersion)
            || host.state === "unknown" && host.partVersion === undefined && host.appVersion === undefined)
        hostIntent = { version: hostVersion, host: expectedEffect ? beforeHost : host }
      }
      let offer: Awaited<ReturnType<IntegrationAttachments["hosts"]>>["offers"][number] | undefined
      if (action.action === "attach") {
        const hosts = bundlesHostsResultSchema.parse(await this.deps.attachments.hosts(context.instanceId, entry.id,
          context.location, currentSignal, context.authority))
        offer = hosts.offers.find(candidate => candidate.offerID === action.offerID)
        if (!offer || offer.protocol !== "ok") stale()
      }
      const session = await context.connection.client.session.get({ sessionID: context.sessionID }, { signal: currentSignal })
      if (session.id !== context.sessionID || !sameLocation(readLocationRef(session.location), context.location)) stale()
      await this.authorize(context, currentSignal)
      const target: BundlesTarget = { instance: context.instanceId, session: context.sessionID,
        location: JSON.stringify(context.location), connection: connectionIdentity(context.connection), integration: entry.id, scope,
        range: entry.range, documentDigest: digest(JSON.stringify({
          catalog: [entry.id, entry.family, entry.package, entry.plugin, entry.rpc, entry.range, entry.host, entry.vendor, entry.sources],
          document, declaration, runtimeTarget, runtimeIdentity, offer, hostIntent,
        })) }
      const version = recognition.runtime?.source.type === "package" ? recognition.runtime.source.version : undefined
      return { target, entry, offer, installation: action.action === "install" ? { integration: entry.id, scope, runtimeID: entry.plugin,
        directory: context.location.directory, target: integrationSourceIdentity(context.instanceId, context.location, context.connection,
          { scope, path: targetDocument.path, target: `${entry.package}@${entry.range}`, entryIndex: targetDocument.document.plugins.length }) } : undefined,
        version: hostVersion ?? (version && integrationStatusSchema.shape.integration.shape.version.safeParse(version).success ? version : entry.range),
        conversation: displayText(session.title ?? "", context.sessionID) }
    }

    const initial = await read(signal)
    const prepared: BundlesPrepared = {
      target: initial.target,
      display: { action: action.action === "setActive" ? action.active ? "enable" : "disable" : action.action,
        integration: displayText(initial.entry.displayName, initial.entry.id, 60), scope, version: initial.version,
         conversation: initial.conversation, ...(initial.offer ? {
          document: [initial.offer.label, initial.offer.document].filter(Boolean).join(" — "),
        } : {}), ...(initial.installation ? { installation: initial.installation } : {}) },
      readTarget: async readSignal => (await read(readSignal)).target,
      dispatch: async (authority, notify) => {
        const fenced: NativeMutationAuthority = {
          assertCurrent: () => { signal.throwIfAborted(); context.authority.assertCurrent(); context.connection.assertCurrent(); authority.assertCurrent() },
          revalidate: async () => {
            // The lifecycle owns the fresh readTarget and exact captured-target comparison.
            await authority.revalidate()
            fenced.assertCurrent()
          },
          onSubmitted: () => {
            if (submitted) return
            fenced.assertCurrent(); submitted = true
            authority.onSubmitted?.(); notify()
          },
        }
        switch (action.action) {
          case "install": await this.deps.sources.add(context.instanceId, { location: context.location, scope,
            spec: `${initial.entry.package}@${initial.entry.range}` }, fenced); break
          case "remove":
            try {
              await this.deps.sources.remove(context.instanceId, removal!, fenced)
              requireRemoved = true
              await fenced.revalidate()
            } catch (error) { throw submitted ? new NativeMutationUncertainError() : error }
            break
          case "setActive": await this.deps.controls.mutate(context.instanceId, { location: context.location, scope,
            pluginId: initial.entry.plugin, enabled: action.active }, fenced); break
          case "update": await this.deps.packages.update(context.instanceId, context.location, nativeTarget!, signal, fenced); break
          case "installHost": await this.deps.attachments.installHost(context.instanceId, initial.entry.id, context.location, signal, fenced); break
          case "attach": await this.deps.attachments.attach(context.instanceId, initial.entry.id, context.location,
            { sessionID: context.sessionID, offerID: action.offerID }, signal, fenced); break
        }
      },
    }
    return prepared
  }

  /** Trusted in-process D24 seam only. Post-submission failures retain NativeMutationUncertainError for reconciliation. */
  async detach(input: BundlesHostContext, integration: string, outer: AbortSignal): Promise<{ outcome: "detached" | "none" | "unknown" }> {
    const context = { ...input, location: Object.freeze({ ...input.location }) }
    this.validate(context, integration)
    const signal = AbortSignal.any([outer, context.authority.signal])
    const read = async () => {
      await this.authorize(context, signal)
      const catalog = await this.deps.catalog.read({ refresh: false })
      const entry = catalog.catalog.integrations.find(candidate => candidate.id === integration)
      if (!entry || entry.family !== "native") stale()
      await this.authorize(context, signal)
      return JSON.stringify([entry.id, entry.family, entry.package, entry.plugin, entry.rpc, entry.range])
    }
    const original = await read()
    const authority: NativeMutationAuthority = {
      assertCurrent: () => { signal.throwIfAborted(); context.authority.assertCurrent(); context.connection.assertCurrent() },
      revalidate: async () => { if (await read() !== original) stale(); authority.assertCurrent() },
      onSubmitted: () => context.authority.onSubmitted?.(),
    }
    return this.deps.attachments.detach(context.instanceId, integration, context.location, { sessionID: context.sessionID }, signal, authority)
  }

  private validate(context: BundlesHostContext, integration: string): void {
    if (!bundlesSessionSchema.safeParse(context.sessionID).success || !/^[a-z][a-z0-9-]{0,31}$/.test(integration)
      || context.location.workspaceID !== undefined) stale()
  }

  private async authorize(context: BundlesHostContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); context.authority.assertCurrent(); context.connection.assertCurrent()
    await context.authority.revalidate()
    if (await this.deps.workspaceManager.getSharedServiceConnection(context.instanceId) !== context.connection) stale()
    signal.throwIfAborted(); context.authority.assertCurrent(); context.connection.assertCurrent()
  }
}
