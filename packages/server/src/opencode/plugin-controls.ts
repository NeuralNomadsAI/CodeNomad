import path from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import type { ConfigEntry, LocationRef, PluginInfo } from "@opencode/client"
import type {
  PluginActivationControl,
  PluginActivationMutationRequest,
  PluginActivationMutationResponse,
  PluginConfigScope,
  PluginConfiguredRule,
  PluginConfiguredSource,
  PluginControlLocation,
  PluginControlScope,
  PluginControlTarget,
  PluginControlsSnapshot,
  PluginRuntimeInventoryEntry,
  PluginRuntimeSource,
  PluginScopeRuleState,
} from "../api-types"
import type { Logger } from "../logger"
import type { WorkspaceManager } from "../workspaces/manager"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { locationRequestOptions } from "./compatibility/location"
import {
  appendPluginControlRule,
  hostPluginControlDocumentFileSystem,
  readPluginControlDocument,
  replacePluginControlDocument,
  type PluginConfigEntry,
  type PluginControlDocument,
  type PluginControlDocumentFileSystem,
  PluginControlDocumentError,
} from "./plugin-control-document"
import { createWslPluginControlDocumentFileSystem } from "./plugin-control-document-wsl"

type PluginControlsWorkspaceManager = Pick<WorkspaceManager,
  | "get"
  | "getSharedServiceConnection"
  | "ownsLocation"
  | "getServiceDirectoryForPath"
  | "getWorktreeIdentityForPath"
  | "getServicePathStyle"
  | "getServiceWslDistro"
  | "getHostPathForServicePath"
>

interface PluginControlsMutationFence {
  enter(identities: string[]): (() => void) | undefined
}

type PathStyle = "win32" | "posix"

interface ReadContext {
  connection: ServiceConnection
  entries: ConfigEntry[]
  runtime: PluginInfo[]
  location: PluginControlLocation
  paths: path.PlatformPath
  style: PathStyle
  globalDirectory: string
  targets: ResolvedTarget[]
  fileSystem: PluginControlDocumentFileSystem
}

interface ResolvedTarget extends PluginControlTarget {
  ioPath: string
}

interface ConfigDocumentView {
  path?: string
  scope: PluginConfigScope
  plugins: readonly PluginConfigEntry[]
  order: number
}

export type PluginControlsErrorKind = "not-found" | "forbidden" | "invalid" | "conflict" | "unavailable"

export class PluginControlsError extends Error {
  readonly cause?: unknown

  constructor(message: string, readonly kind: PluginControlsErrorKind, options?: { cause?: unknown }) {
    super(message)
    this.name = "PluginControlsError"
    if (options && "cause" in options) this.cause = options.cause
  }
}

export class PluginControls {
  private readonly mutationTails = new Map<string, Promise<void>>()

  constructor(private readonly options: {
    workspaceManager: PluginControlsWorkspaceManager
    worktreeDeletionFence: PluginControlsMutationFence
    logger: Logger
  }) {}

  async read(workspaceId: string, location: PluginControlLocation): Promise<PluginControlsSnapshot> {
    const context = await this.readContext(workspaceId, location)
    return buildSnapshot(context)
  }

  // Shared scope acquisition for native settings that have no native write API.
  // Callers receive only the already-authorized documents; path/WSL selection,
  // deletion admission, connection fencing and atomic conflict checks stay here.
  async readConfigDocuments(workspaceId: string, location: PluginControlLocation, declaredSources = false) {
    const context = await this.readContext(workspaceId, location)
    const targets = declaredSources ? await this.declaredTargets(workspaceId, context) : context.targets
    const documents = await Promise.all(targets.map(async target => ({
      scope: target.scope, path: target.path,
      document: await readPluginControlDocument(target.ioPath, context.fileSystem),
    })))
    assertCurrentConnection(context.connection)
    return { location: context.location, entries: context.entries, documents }
  }

  editConfigDocument(
    workspaceId: string,
    location: PluginControlLocation,
    scope: PluginControlScope,
    edit: (document: PluginControlDocument) => string,
    declaration?: string[],
  ): Promise<void> {
    const directory = location.directory.trim().replace(/[\\/]+$/, "").toLowerCase()
    const key = scope === "global" ? `${workspaceId}\nglobal` : `${workspaceId}\nproject\n${directory}`
    return this.serializeMutation(key, async () => {
      const context = await this.readContext(workspaceId, location)
      let target = context.targets.find(target => target.scope === scope)
      if (declaration) {
        target = undefined
        for (const candidate of await this.declaredTargets(workspaceId, context)) {
          if (candidate.scope !== scope) continue
          const document = await readPluginControlDocument(candidate.ioPath, context.fileSystem)
          if (readNativeSetting(document, declaration) !== undefined) target = candidate
        }
      }
      if (!target) throw new PluginControlsError(declaration ? "Setting is not configured in this scope" : "OpenCode configuration scope is unavailable", declaration ? "conflict" : "unavailable")
      const identity = await this.options.workspaceManager.getWorktreeIdentityForPath(workspaceId, context.location.directory)
      if (!identity) throw new PluginControlsError("Location is not owned by an active worktree", "forbidden")
      const release = this.options.worktreeDeletionFence.enter([identity])
      if (!release) throw new PluginControlsError("Worktree deletion is in progress", "conflict")
      try {
        const document = await readPluginControlDocument(target.ioPath, context.fileSystem)
        const updated = edit(document)
        await replacePluginControlDocument(document, updated, {
          beforeCommit: () => assertCurrentConnection(context.connection),
        }, context.fileSystem)
      } catch (error) { throw error instanceof PluginControlDocumentError ? mapDocumentError(error) : error }
      finally { release() }
    })
  }

  mutate(workspaceId: string, request: PluginActivationMutationRequest): Promise<PluginActivationMutationResponse> {
    // Ordering is only required per write target. The global document is
    // daemon-wide for one workspace, so all of its global writes share one
    // queue regardless of which worktree directory requested them; project
    // writes queue per normalized directory. A fully file-identity-based key
    // would need async resolution, so a residual cross-workspace global race
    // stays possible and remains fail-closed with a retryable conflict.
    const normalizedDirectory = request.location.directory.trim().replace(/[\\/]+$/, "").toLowerCase()
    const tailKey = request.scope === "global"
      ? `${workspaceId}\nglobal`
      : `${workspaceId}\nproject\n${normalizedDirectory}`
    return this.serializeMutation(tailKey, async () => {
      const context = await this.readContext(workspaceId, request.location)
      const target = context.targets.find((candidate) => candidate.scope === request.scope)
      if (!target) throw new PluginControlsError("OpenCode configuration scope is unavailable", "unavailable")
      const identity = await this.options.workspaceManager.getWorktreeIdentityForPath(workspaceId, context.location.directory)
      if (!identity) throw new PluginControlsError("Location is not owned by an active worktree", "forbidden")
      const release = this.options.worktreeDeletionFence.enter([identity])
      if (!release) throw new PluginControlsError("Worktree deletion is in progress", "conflict")

      try {
        let document
        try {
          document = await readPluginControlDocument(target.ioPath, context.fileSystem)
        } catch (error) {
          throw mapDocumentError(error)
        }
        // The daemon's ConfigEntry values have already applied environment and
        // config substitutions. Keep those values authoritative for inventory
        // and state; the raw document is used only for conflict-safe editing.
        // The base is built once: authorization, projection, and both
        // snapshots derive from the same documents and runtime inventory.
        const base = snapshotBase(context)
        const authoritative = controlsForDocuments(base, context)
        const projection = mutationTargetPlugins(
          base.documents,
          context.paths,
          target.path,
          document.plugins,
          authoritative.controls.map((candidate) => candidate.id),
        )
        const before = controlsForDocuments(base, context, {
          servicePath: target.path,
          plugins: projection.plugins,
          scope: request.scope,
        })
        const control = before.controls.find((candidate) => candidate.id === request.pluginId)
        if (!control) throw new PluginControlsError("Plugin ID is not present in the authorized inventory", "forbidden")

        const desired: PluginScopeRuleState = request.enabled ? "enabled" : "disabled"
        assertCurrentConnection(context.connection)
        if (projection.noOpSafe && control[request.scope] === desired) {
          return {
            snapshot: before,
            rule: request.enabled ? request.pluginId : `-${request.pluginId}`,
            target: publicTarget(target),
            changed: false,
            reloadPending: false,
          }
        }

        const rule = request.enabled ? request.pluginId : `-${request.pluginId}`
        const updated = appendPluginControlRule(document, rule)
        try {
          await replacePluginControlDocument(document, updated, {
            beforeCommit: () => assertCurrentConnection(context.connection),
          }, context.fileSystem)
        } catch (error) {
          throw mapDocumentError(error)
        }
        target.exists = true
        const snapshot = controlsForDocuments(base, context, {
          servicePath: target.path,
          plugins: [...projection.plugins, rule],
          scope: request.scope,
        })
        this.options.logger.info({ workspaceId, scope: request.scope, pluginId: request.pluginId }, "Updated OpenCode plugin activation rule")
        return { snapshot, rule, target: publicTarget(target), changed: true, reloadPending: true }
      } finally {
        release()
      }
    })
  }

  private async readContext(workspaceId: string, input: PluginControlLocation): Promise<ReadContext> {
    if (!this.options.workspaceManager.get(workspaceId)) {
      throw new PluginControlsError("Workspace not found", "not-found")
    }
    const requestedLocation = normalizeLocation(input)
    const connection = await this.options.workspaceManager.getSharedServiceConnection(workspaceId)
    if (!connection) throw new PluginControlsError("OpenCode service is unavailable", "unavailable")
    const serviceDirectory = await this.options.workspaceManager.getServiceDirectoryForPath(
      workspaceId,
      requestedLocation.directory,
    )
    if (!serviceDirectory) throw new PluginControlsError("Location is not owned by this workspace", "forbidden")
    const location = { ...requestedLocation, directory: serviceDirectory }
    if (!await this.options.workspaceManager.ownsLocation(workspaceId, location, connection.client)) {
      throw new PluginControlsError("Location is not owned by this workspace", "forbidden")
    }

    const requestLocation = { directory: location.directory }
    const requestOptions = locationRequestOptions(location)
    let entries: ConfigEntry[]
    let runtime: PluginInfo[]
    try {
      const [configOutput, pluginOutput] = await Promise.all([
        connection.client.config.get({ location: requestLocation }, requestOptions),
        connection.client.plugin.list({ location: requestLocation }, requestOptions),
      ])
      connection.assertCurrent()
      if (!Array.isArray(configOutput) || !pluginOutput || !Array.isArray(pluginOutput.data)) {
        throw new Error("Unexpected OpenCode plugin controls response")
      }
      entries = configOutput
      runtime = pluginOutput.data
    } catch (error) {
      if (error instanceof PluginControlsError) throw error
      throw new PluginControlsError("Unable to read OpenCode plugin configuration", "unavailable", { cause: error })
    }

    const style = this.options.workspaceManager.getServicePathStyle(workspaceId)
    if (!style) throw new PluginControlsError("Workspace path context is unavailable", "unavailable")
    const paths = style === "win32" ? path.win32 : path.posix
    const globalDirectory = entries.find((entry) => entry?.type === "directory")?.path
    if (typeof globalDirectory !== "string" || !validAbsolutePath(paths, globalDirectory)) {
      throw new PluginControlsError("OpenCode did not report its global configuration directory", "unavailable")
    }
    if (!validAbsolutePath(paths, location.directory)) {
      throw new PluginControlsError("OpenCode location directory is invalid", "invalid")
    }
    const distro = this.options.workspaceManager.getServiceWslDistro(workspaceId)
    const fileSystem = distro
      ? createWslPluginControlDocumentFileSystem(distro)
      : hostPluginControlDocumentFileSystem
    const targets = await this.resolveTargets(workspaceId, paths, globalDirectory, location.directory, entries, fileSystem, Boolean(distro))
    assertCurrentConnection(connection)
    return { connection, entries, runtime, location, paths, style, globalDirectory, targets, fileSystem }
  }

  private async resolveTargets(
    workspaceId: string,
    paths: path.PlatformPath,
    globalDirectory: string,
    projectDirectory: string,
    entries: readonly ConfigEntry[],
    fileSystem: PluginControlDocumentFileSystem,
    nativeWsl: boolean,
  ): Promise<ResolvedTarget[]> {
    const [globalIoRoot, projectIoRoot] = nativeWsl
      ? [globalDirectory, projectDirectory]
      : await Promise.all([
        this.options.workspaceManager.getHostPathForServicePath(workspaceId, globalDirectory),
        this.options.workspaceManager.getHostPathForServicePath(workspaceId, projectDirectory),
      ])
    if (!globalIoRoot || !projectIoRoot) {
      throw new PluginControlsError("OpenCode configuration paths could not be mapped to the execution host", "unavailable")
    }
    const ioPaths = nativeWsl ? path.posix : hostPathStyle()
    if (!ioPaths.isAbsolute(globalIoRoot) || !ioPaths.isAbsolute(projectIoRoot)) {
      throw new PluginControlsError("OpenCode configuration paths could not be mapped to the execution host", "unavailable")
    }
    const globalCandidates = targetCandidates("global", paths, globalDirectory, globalIoRoot, ioPaths)
    const projectCandidates = targetCandidates("project", paths, projectDirectory, projectIoRoot, ioPaths)
    let inspected: Array<{ writePath: string; exists: boolean }>
    try {
      inspected = await fileSystem.inspectMany([...globalCandidates, ...projectCandidates].map((candidate) => candidate.ioPath))
    } catch (error) {
      throw mapDocumentError(error)
    }
    const globalTarget = selectTarget("global", globalCandidates, inspected.slice(0, globalCandidates.length))
    // Every inherited .opencode document follows every direct document. Keep
    // the write inside this location, creating its higher-precedence layer
    // when an existing direct file cannot override the inherited rules.
    const inheritedProjectLayer = entries.some((entry) => {
      if (entry.type !== "document" || !entry.path) return false
      const directory = paths.dirname(entry.path)
      const root = paths.dirname(directory)
      return paths.basename(directory) === ".opencode" && !samePath(paths, directory, globalDirectory)
        && !samePath(paths, root, projectDirectory) && containsPath(paths, root, projectDirectory)
    })
    const projectInspected = inspected.slice(globalCandidates.length)
    const projectTarget = inheritedProjectLayer
      ? selectTarget("project", projectCandidates.slice(2), projectInspected.slice(2))
      : selectTarget("project", projectCandidates, projectInspected)
    // An opened global config directory can make the direct project candidate
    // resolve to the global document. Never expose two scopes backed by one
    // file: a Project write would otherwise mutate Global configuration.
    return samePath(paths, globalDirectory, projectDirectory)
      || samePath(ioPaths, globalTarget.ioPath, projectTarget.ioPath)
      // A symlinked fallback must not turn a location-local override into an
      // edit of the ancestor/shared configuration it was meant to override.
      || (inheritedProjectLayer && !containsPath(ioPaths, projectIoRoot, projectTarget.ioPath))
      ? [globalTarget]
      : [globalTarget, projectTarget]
  }

  private async declaredTargets(workspaceId: string, context: ReadContext): Promise<ResolvedTarget[]> {
    const nativeWsl = Boolean(this.options.workspaceManager.getServiceWslDistro(workspaceId))
    const ioPaths = nativeWsl ? path.posix : hostPathStyle()
    const result: ResolvedTarget[] = []
    const globalWrites = new Set<string>()
    for (const scope of ["global", "project"] as const) {
      const root = scope === "global" ? context.globalDirectory : context.location.directory
      if (scope === "project" && samePath(context.paths, root, context.globalDirectory)) continue
      const ioRoot = nativeWsl ? root : await this.options.workspaceManager.getHostPathForServicePath(workspaceId, root)
      if (!ioRoot || !ioPaths.isAbsolute(ioRoot)) throw new PluginControlsError("Configuration source unavailable", "unavailable")
      const candidates = targetCandidates(scope, context.paths, root, ioRoot, ioPaths)
      const inspected = await context.fileSystem.inspectMany(candidates.map(item => item.ioPath))
      for (const entry of context.entries) {
        if (entry.type !== "document" || !entry.path) continue
        const index = candidates.findIndex(item => samePath(context.paths, item.servicePath, entry.path!))
        if (index < 0 || !inspected[index]?.exists) continue
        const ioPath = inspected[index]!.writePath
        if (scope === "project" && (!containsPath(ioPaths, ioRoot, ioPath) || [...globalWrites].some(value => samePath(ioPaths, value, ioPath)))) continue
        if (scope === "global") globalWrites.add(ioPath)
        result.push({ scope, path: candidates[index]!.servicePath, ioPath, exists: true })
      }
    }
    assertCurrentConnection(context.connection)
    return result
  }

  private serializeMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const tail = this.mutationTails.get(key) ?? Promise.resolve()
    const result = tail.then(operation, operation)
    const tracked = result.then(() => undefined, () => undefined)
    this.mutationTails.set(key, tracked)
    const forget = () => { if (this.mutationTails.get(key) === tracked) this.mutationTails.delete(key) }
    result.then(forget, forget)
    return result
  }
}

interface SnapshotBase {
  runtime: PluginRuntimeInventoryEntry[]
  runtimeIds: Set<string>
  runtimeSourceIds: Map<string, string>
  runtimeById: Map<string, PluginRuntimeInventoryEntry>
  documents: ConfigDocumentView[]
  sourceOrders: number[]
}

const controlIdCollator = new Intl.Collator("en", { sensitivity: "variant" })

function snapshotBase(context: ReadContext): SnapshotBase {
  const runtime = context.runtime.map(normalizeRuntimeEntry)
  const runtimeIds = new Set<string>()
  const runtimeSourceIds = new Map<string, string>()
  const runtimeById = new Map<string, PluginRuntimeInventoryEntry>()
  for (const entry of runtime) {
    if (!entry.id) continue
    // Duplicate IDs are invalid daemon output; keep first-wins attachment so a
    // repeated entry cannot displace the inventory record already published.
    if (!runtimeById.has(entry.id)) runtimeById.set(entry.id, entry)
    runtimeIds.add(entry.id)
    if (entry.source.type === "package") runtimeSourceIds.set(entry.source.target, entry.id)
    else if (entry.source.type === "local") runtimeSourceIds.set(entry.source.path, entry.id)
  }
  return { runtime, runtimeIds, runtimeSourceIds, runtimeById, ...configDocuments(context) }
}

function buildSnapshot(
  context: ReadContext,
  overlay?: { servicePath: string; plugins: readonly PluginConfigEntry[]; scope: PluginControlScope },
): PluginControlsSnapshot {
  return controlsForDocuments(snapshotBase(context), context, overlay)
}

function controlsForDocuments(
  base: SnapshotBase,
  context: ReadContext,
  overlay?: { servicePath: string; plugins: readonly PluginConfigEntry[]; scope: PluginControlScope },
): PluginControlsSnapshot {
  const { runtime, runtimeIds, runtimeSourceIds, runtimeById } = base
  const documents = overlay ? applyOverlay(base, context, overlay) : base.documents
  const knownDefinitions = new Set(runtimeIds)
  const declaredTargets = new Set<string>()
  const rules: PluginConfiguredRule[] = []
  const sources: PluginConfiguredSource[] = []
  for (const document of documents) {
    document.plugins.forEach((entry, entryIndex) => {
      if (typeof entry !== "string") {
        sources.push({ target: entry.package, scope: document.scope, path: document.path, entryIndex, hasOptions: entry.options !== undefined })
        const runtimeId = runtimeIdForConfiguredTarget(context, document, entry.package, runtimeById, runtimeSourceIds)
        const isFirstRuntimeSourceDeclaration = Boolean(runtimeId && !declaredTargets.has(entry.package))
        const selectsPlugin = entry.package.startsWith("opencode.")
          || (!isFirstRuntimeSourceDeclaration && knownDefinitions.has(entry.package))
        if (selectsPlugin) {
          rules.push({ selector: entry.package, enabled: true, scope: document.scope, path: document.path, order: document.order, entryIndex })
        } else if (runtimeId && rules.some((rule) => !rule.enabled && matchesSelector(rule.selector, runtimeId))) {
          // Every object entry is an ordered add operation. Loading the source
          // after a matching removal enables its resolved plugin again.
          rules.push({ selector: runtimeId, enabled: true, scope: document.scope, path: document.path, order: document.order, entryIndex })
        }
        declaredTargets.add(entry.package)
        if (runtimeId) knownDefinitions.add(runtimeId)
        return
      }
      const disabled = entry.startsWith("-")
      const selector = disabled ? entry.slice(1) : entry
      if (disabled) {
        rules.push({ selector, enabled: false, scope: document.scope, path: document.path, order: document.order, entryIndex })
        if (isExactSelector(selector)) knownDefinitions.add(selector)
        return
      }

      const runtimeSourceId = runtimeIdForConfiguredTarget(context, document, selector, runtimeById, runtimeSourceIds)
      const isFirstRuntimeSourceDeclaration = Boolean(runtimeSourceId && !declaredTargets.has(selector))
      const selectsPlugin = selector === "*" || selector.endsWith(".*") || selector.startsWith("opencode.")
        || (!isFirstRuntimeSourceDeclaration && knownDefinitions.has(selector))
      if (!selectsPlugin) {
        sources.push({ target: selector, scope: document.scope, path: document.path, entryIndex, hasOptions: false })
        declaredTargets.add(selector)
        if (runtimeSourceId) {
          if (rules.some((rule) => !rule.enabled && matchesSelector(rule.selector, runtimeSourceId))) {
            rules.push({ selector: runtimeSourceId, enabled: true, scope: document.scope, path: document.path, order: document.order, entryIndex })
          }
          knownDefinitions.add(runtimeSourceId)
        }
        return
      }
      rules.push({ selector, enabled: true, scope: document.scope, path: document.path, order: document.order, entryIndex })
    })
  }

  const ids = new Set<string>(runtimeIds)
  for (const rule of rules) {
    if (isExactSelector(rule.selector)) ids.add(rule.selector)
  }
  const controls = [...ids].filter(validPluginId).sort(controlIdCollator.compare).map((id) => {
    const matching = rules.filter((rule) => matchesSelector(rule.selector, id))
    const controllingRule = matching.at(-1)
    const runtimeEntry = runtimeById.get(id)
    return {
      id,
      ...(runtimeEntry ? { runtime: runtimeEntry } : {}),
      builtin: runtimeEntry?.source.type === "builtin" || id.startsWith("opencode."),
      effective: stateForRule(controllingRule),
      global: stateForRule(matching.filter((rule) => rule.scope === "global").at(-1)),
      project: stateForRule(matching.filter((rule) => rule.scope === "project").at(-1)),
      ...(controllingRule ? { controllingRule } : {}),
    } satisfies PluginActivationControl
  })
  return {
    location: context.location,
    runtime,
    configured: { rules, sources },
    controls,
    targets: context.targets.map(publicTarget),
  }
}

function mutationTargetPlugins(
  documents: readonly ConfigDocumentView[],
  paths: path.PlatformPath,
  servicePath: string,
  rawPlugins: readonly PluginConfigEntry[],
  authorizedIds: readonly string[],
): { plugins: readonly PluginConfigEntry[]; noOpSafe: boolean } {
  const normalized = documents
    .filter((document) => Boolean(document.path && samePath(paths, document.path, servicePath)))
    .at(-1)?.plugins ?? []
  let noOpSafe = !rawPlugins.some(containsConfigVariable)
  let normalizedIndex = 0
  const pendingRules: string[] = []
  for (const entry of rawPlugins) {
    if (containsConfigVariable(entry)) {
      if (normalizedIndex < normalized.length) normalizedIndex += 1
      continue
    }
    if (normalizedIndex < normalized.length) {
      if (pluginEntriesEqual(entry, normalized[normalizedIndex])) normalizedIndex += 1
      else noOpSafe = false
      continue
    }
    if (typeof entry !== "string") {
      noOpSafe = false
      continue
    }
    const selector = entry.startsWith("-") ? entry.slice(1) : entry
    if (!selector || !authorizedIds.some((id) => matchesSelector(selector, id))) {
      noOpSafe = false
      continue
    }
    pendingRules.push(entry)
  }
  // Only a completely matched prefix followed by replayed concrete rules can
  // prove a durable no-op. Deletions/replacements during watcher lag cannot.
  return { plugins: [...normalized, ...pendingRules], noOpSafe: noOpSafe && normalizedIndex === normalized.length }
}

function pluginEntriesEqual(left: PluginConfigEntry, right: PluginConfigEntry | undefined): boolean {
  if (typeof left !== typeof right) return false
  if (typeof left === "string" || typeof right === "string") return left === right
  if (left.package !== (right as { package: string }).package) return false
  const leftOptions = (left as { options?: Record<string, unknown> }).options
  const rightOptions = (right as { options?: Record<string, unknown> }).options
  if (leftOptions === rightOptions) return true
  if (!leftOptions || !rightOptions) return false
  // Options objects are user-controlled and unbounded; only pay for a deep
  // walk when the cheap package and key-count checks already match.
  if (Object.keys(leftOptions).length !== Object.keys(rightOptions).length) return false
  return isDeepStrictEqual(leftOptions, rightOptions)
}

function containsConfigVariable(value: unknown): boolean {
  if (typeof value === "string") return /\{(?:env|file):[^}]+\}/.test(value)
  if (Array.isArray(value)) return value.some(containsConfigVariable)
  return isRecord(value) && Object.values(value).some(containsConfigVariable)
}

function configDocuments(
  context: ReadContext,
  overlay?: { servicePath: string; plugins: readonly PluginConfigEntry[]; scope: PluginControlScope },
): { documents: ConfigDocumentView[]; sourceOrders: number[] } {
  const documents: Array<Omit<ConfigDocumentView, "order"> & { sourceOrder: number }> = []
  let overlaid = false
  let targetDirectoryOrder: number | undefined
  context.entries.forEach((entry, sourceOrder) => {
    if (overlay && entry?.type === "directory" && samePath(context.paths, entry.path, context.paths.dirname(overlay.servicePath))) {
      targetDirectoryOrder = sourceOrder
    }
    if (entry?.type !== "document") return
    const servicePath = typeof entry.path === "string" ? entry.path : undefined
    const matchesOverlay = Boolean(overlay && servicePath && samePath(context.paths, servicePath, overlay.servicePath))
    if (matchesOverlay) overlaid = true
    documents.push({
      path: servicePath,
      scope: matchesOverlay ? overlay!.scope : classifyScope(context, servicePath),
      plugins: matchesOverlay ? overlay!.plugins : normalizePluginEntries(entry.info?.plugins),
      sourceOrder,
    })
  })
  if (overlay && !overlaid) {
    const lastPhysicalOrder = context.entries.reduce((latest, entry, index) => (
      typeof entry?.path === "string" ? index : latest
    ), -1)
    documents.push({
      path: overlay.servicePath,
      scope: overlay.scope,
      plugins: overlay.plugins,
      sourceOrder: targetDirectoryOrder === undefined ? lastPhysicalOrder + 0.5 : targetDirectoryOrder - 0.5,
    })
  }
  const sorted = documents
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
  return {
    documents: sorted.map(({ sourceOrder: _sourceOrder, ...document }, order) => ({ ...document, order })),
    sourceOrders: sorted.map((document) => document.sourceOrder),
  }
}

function applyOverlay(
  base: SnapshotBase,
  context: ReadContext,
  overlay: { servicePath: string; plugins: readonly PluginConfigEntry[]; scope: PluginControlScope },
): ConfigDocumentView[] {
  const matched = base.documents.some((document) => Boolean(document.path && samePath(context.paths, document.path, overlay.servicePath)))
  if (matched) {
    return base.documents.map((document) => (
      document.path && samePath(context.paths, document.path, overlay.servicePath)
        ? { ...document, scope: overlay.scope, plugins: overlay.plugins }
        : document
    ))
  }
  // The overlay target has no daemon document yet (missing file or virtual
  // precedence): insert it where configDocuments would have placed it so
  // derived snapshots keep daemon precedence without re-walking entries.
  let targetDirectoryOrder: number | undefined
  let lastPhysicalOrder = -1
  context.entries.forEach((entry, sourceOrder) => {
    if (entry?.type === "directory" && samePath(context.paths, entry.path, context.paths.dirname(overlay.servicePath))) {
      targetDirectoryOrder = sourceOrder
    }
    if (typeof entry?.path === "string") lastPhysicalOrder = sourceOrder
  })
  const overlaySourceOrder = targetDirectoryOrder === undefined ? lastPhysicalOrder + 0.5 : targetDirectoryOrder - 0.5
  const insertAt = base.sourceOrders.filter((order) => order < overlaySourceOrder).length
  return [
    ...base.documents.slice(0, insertAt),
    { path: overlay.servicePath, scope: overlay.scope, plugins: overlay.plugins, order: insertAt },
    ...base.documents.slice(insertAt).map((document) => ({ ...document, order: document.order + 1 })),
  ]
}

function classifyScope(context: ReadContext, servicePath?: string): PluginConfigScope {
  if (!servicePath) return "virtual"
  const parent = context.paths.dirname(servicePath)
  if (samePath(context.paths, parent, context.globalDirectory)) return "global"
  const configRoot = context.paths.basename(parent) === ".opencode" ? context.paths.dirname(parent) : parent
  return containsPath(context.paths, configRoot, context.location.directory) ? "project" : "other"
}

interface TargetCandidate {
  servicePath: string
  ioPath: string
}

function targetCandidates(
  scope: PluginControlScope,
  servicePaths: path.PlatformPath,
  serviceRoot: string,
  ioRoot: string,
  ioPaths: path.PlatformPath,
): TargetCandidate[] {
  const relativeCandidates = scope === "global"
    ? ["opencode.json", "opencode.jsonc"]
    : ["opencode.json", "opencode.jsonc", servicePaths.join(".opencode", "opencode.json"), servicePaths.join(".opencode", "opencode.jsonc")]
  return relativeCandidates.map((relative) => ({
    servicePath: servicePaths.join(serviceRoot, relative),
    ioPath: ioPaths.join(ioRoot, ...relative.split(/[\\/]/)),
  }))
}

function selectTarget(
  scope: PluginControlScope,
  candidates: readonly TargetCandidate[],
  inspected: readonly { writePath: string; exists: boolean }[],
): ResolvedTarget {
  if (candidates.length !== inspected.length) {
    throw new PluginControlsError("OpenCode configuration target inspection was incomplete", "unavailable")
  }
  let selected = candidates.at(-1)!
  let exists = false
  candidates.forEach((candidate, index) => {
    const result = inspected[index]!
    if (result.exists) {
      selected = { ...candidate, ioPath: result.writePath }
      exists = true
    }
  })
  if (!exists) {
    selected = { ...selected, ioPath: inspected.at(-1)!.writePath }
  }
  return { scope, path: selected.servicePath, ioPath: selected.ioPath, exists }
}

function normalizeRuntimeEntry(plugin: PluginInfo, index: number): PluginRuntimeInventoryEntry {
  if (!isRecord(plugin) || !isRecord(plugin.state)) {
    throw new PluginControlsError("OpenCode returned an invalid plugin inventory", "unavailable")
  }
  const source = normalizeRuntimeSource(plugin.source)
  const id = typeof plugin?.id === "string" && validPluginId(plugin.id) ? plugin.id : undefined
  const features = isRecord(plugin?.features) ? {
    ...(plugin.features.server === true ? { server: true as const } : {}),
    ...(plugin.features.tui === true ? { tui: true as const } : {}),
    ...(plugin.features.rpc === true ? { rpc: true as const } : {}),
  } : {}
  const state = plugin.state.status === "active"
    ? { status: "active" as const }
    : plugin.state.status === "failed" && typeof plugin.state.error === "string"
      ? { status: "failed" as const, error: plugin.state.error, ...(typeof plugin.state.ref === "string" ? { ref: plugin.state.ref } : {}) }
      : undefined
  if (!state) throw new PluginControlsError("OpenCode returned an invalid plugin inventory", "unavailable")
  return { key: id ?? `${source.type}:${sourceDetail(source)}:${index}`, ...(id ? { id } : {}), source, features, state }
}

function normalizeRuntimeSource(source: unknown): PluginRuntimeSource {
  if (!isRecord(source)) throw new PluginControlsError("OpenCode returned an invalid plugin source", "unavailable")
  if (source.type === "builtin") return { type: "builtin" }
  if (source.type === "sdk") return { type: "sdk" }
  if (source.type === "local" && typeof source.path === "string" && source.path) return { type: "local", path: source.path }
  if (source.type === "package" && typeof source.target === "string" && source.target) return {
    type: "package",
    target: source.target,
    ...(typeof source.version === "string" ? { version: source.version } : {}),
    ...(source.outdated === true ? { outdated: true as const } : {}),
    ...(source.updating === true ? { updating: true as const } : {}),
  }
  throw new PluginControlsError("OpenCode returned an invalid plugin source", "unavailable")
}

function normalizePluginEntries(input: unknown): PluginConfigEntry[] {
  if (!Array.isArray(input)) return []
  const output: PluginConfigEntry[] = []
  for (const entry of input) {
    if (typeof entry === "string") output.push(entry)
    else if (isRecord(entry) && typeof entry.package === "string") {
      output.push({ package: entry.package, ...(isRecord(entry.options) ? { options: entry.options } : {}) })
    }
  }
  return output
}

function runtimeIdForConfiguredTarget(
  context: ReadContext,
  document: ConfigDocumentView,
  target: string,
  runtimeById: ReadonlyMap<string, PluginRuntimeInventoryEntry>,
  direct: ReadonlyMap<string, string>,
): string | undefined {
  const exact = direct.get(target)
  if (exact) return exact
  let localTarget: string | undefined
  try {
    if (target.startsWith("file://")) {
      localTarget = fileURLToPath(target, { windows: context.style === "win32" })
    } else if (target.startsWith("./") || target.startsWith("../")) {
      localTarget = context.paths.resolve(document.path ? context.paths.dirname(document.path) : context.location.directory, target)
    } else if (context.paths.isAbsolute(target)) {
      localTarget = target
    }
  } catch {
    return undefined
  }
  if (!localTarget) return undefined
  for (const entry of runtimeById.values()) {
    if (!entry.id || entry.source.type !== "local") continue
    if (samePath(context.paths, localTarget, entry.source.path)
      || containsPath(context.paths, localTarget, entry.source.path)) return entry.id
  }
  return undefined
}

function normalizeLocation(input: PluginControlLocation): LocationRef & PluginControlLocation {
  const directory = input.directory?.trim()
  const workspaceID = input.workspaceID?.trim()
  if (!directory || directory.includes("\0") || (input.workspaceID !== undefined && !workspaceID)) {
    throw new PluginControlsError("Invalid OpenCode location", "invalid")
  }
  return { directory, ...(workspaceID ? { workspaceID } : {}) }
}

function stateForRule(rule: PluginConfiguredRule | undefined): PluginScopeRuleState {
  return rule ? (rule.enabled ? "enabled" : "disabled") : "default"
}

function matchesSelector(selector: string, pluginId: string): boolean {
  return selector === "*" || (selector.endsWith(".*") ? pluginId.startsWith(selector.slice(0, -1)) : selector === pluginId)
}

function isExactSelector(selector: string): boolean {
  return selector !== "*" && !selector.endsWith(".*") && validPluginId(selector)
}

function validPluginId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value === value.trim() && !value.startsWith("-")
    && !value.includes("*") && !/[\u0000-\u001f\u007f]/.test(value)
}

function validAbsolutePath(paths: path.PlatformPath, value: string): boolean {
  return paths.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value)
}

function samePath(paths: path.PlatformPath, left: string, right: string): boolean {
  const normalize = (value: string) => paths.normalize(value).replace(/[\\/]$/, "")
  const a = normalize(left)
  const b = normalize(right)
  return paths === path.win32 ? a.toLowerCase() === b.toLowerCase() : a === b
}

function containsPath(paths: path.PlatformPath, candidate: string, directory: string): boolean {
  const relative = paths.relative(candidate, directory)
  return relative === "" || (!relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative))
}

function hostPathStyle(): path.PlatformPath {
  return process.platform === "win32" ? path.win32 : path.posix
}

function sourceDetail(source: PluginRuntimeSource): string {
  if (source.type === "package") return source.target
  if (source.type === "local") return source.path
  return source.type
}

function publicTarget(target: ResolvedTarget): PluginControlTarget {
  return { scope: target.scope, path: target.path, exists: target.exists }
}

function mapDocumentError(error: unknown): PluginControlsError {
  if (!(error instanceof PluginControlDocumentError)) {
    return new PluginControlsError("Unable to update OpenCode configuration", "unavailable", { cause: error })
  }
  const kind = error.kind === "invalid" ? "invalid" : error.kind === "conflict" ? "conflict" : "unavailable"
  return new PluginControlsError(error.message, kind, { cause: error })
}

function assertCurrentConnection(connection: ServiceConnection): void {
  try {
    connection.assertCurrent()
  } catch (error) {
    throw new PluginControlsError("OpenCode service connection changed", "unavailable", { cause: error })
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
import { readNativeSetting } from "./native-setting-document"
