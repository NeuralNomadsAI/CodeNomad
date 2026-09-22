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
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: {
    workspaceManager: PluginControlsWorkspaceManager
    worktreeDeletionFence: PluginControlsMutationFence
    logger: Logger
  }) {}

  async read(workspaceId: string, location: PluginControlLocation): Promise<PluginControlsSnapshot> {
    const context = await this.readContext(workspaceId, location)
    return buildSnapshot(context)
  }

  mutate(workspaceId: string, request: PluginActivationMutationRequest): Promise<PluginActivationMutationResponse> {
    return this.serializeMutation(async () => {
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
        const authoritative = buildSnapshot(context)
        const projection = mutationTargetPlugins(
          context,
          target.path,
          document.plugins,
          authoritative.controls.map((candidate) => candidate.id),
        )
        const before = buildSnapshot(context, {
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
        const snapshot = buildSnapshot(context, {
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
    const targets = await this.resolveTargets(workspaceId, paths, globalDirectory, location.directory, fileSystem, Boolean(distro))
    assertCurrentConnection(connection)
    return { connection, entries, runtime, location, paths, style, globalDirectory, targets, fileSystem }
  }

  private async resolveTargets(
    workspaceId: string,
    paths: path.PlatformPath,
    globalDirectory: string,
    projectDirectory: string,
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
    const projectTarget = selectTarget("project", projectCandidates, inspected.slice(globalCandidates.length))
    // An opened global config directory can make the direct project candidate
    // resolve to the global document. Never expose two scopes backed by one
    // file: a Project write would otherwise mutate Global configuration.
    return samePath(paths, globalDirectory, projectDirectory)
      || samePath(ioPaths, globalTarget.ioPath, projectTarget.ioPath)
      ? [globalTarget]
      : [globalTarget, projectTarget]
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function buildSnapshot(
  context: ReadContext,
  overlay?: { servicePath: string; plugins: readonly PluginConfigEntry[]; scope: PluginControlScope },
): PluginControlsSnapshot {
  const runtime = context.runtime.map(normalizeRuntimeEntry)
  const runtimeIds = new Set(runtime.flatMap((entry) => entry.id ? [entry.id] : []))
  const runtimeSourceIds = new Map(runtime.flatMap((entry): Array<[string, string]> => {
    if (!entry.id) return []
    if (entry.source.type === "package") return [[entry.source.target, entry.id]]
    if (entry.source.type === "local") return [[entry.source.path, entry.id]]
    return []
  }))
  const documents = configDocuments(context, overlay)
  const knownDefinitions = new Set(runtimeIds)
  const declaredTargets = new Set<string>()
  const rules: PluginConfiguredRule[] = []
  const sources: PluginConfiguredSource[] = []
  for (const document of documents) {
    document.plugins.forEach((entry, entryIndex) => {
      if (typeof entry !== "string") {
        sources.push({ target: entry.package, scope: document.scope, path: document.path, entryIndex, hasOptions: entry.options !== undefined })
        const runtimeId = runtimeIdForConfiguredTarget(context, document, entry.package, runtime, runtimeSourceIds)
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

      const runtimeSourceId = runtimeIdForConfiguredTarget(context, document, selector, runtime, runtimeSourceIds)
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

  const ids = new Set([...runtimeIds, ...rules.flatMap((rule) => isExactSelector(rule.selector) ? [rule.selector] : [])])
  const controls = [...ids].filter(validPluginId).sort((left, right) => left.localeCompare(right)).map((id) => {
    const matching = rules.filter((rule) => matchesSelector(rule.selector, id))
    const controllingRule = matching.at(-1)
    const runtimeEntry = runtime.find((entry) => entry.id === id)
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
  context: ReadContext,
  servicePath: string,
  rawPlugins: readonly PluginConfigEntry[],
  authorizedIds: readonly string[],
): { plugins: readonly PluginConfigEntry[]; noOpSafe: boolean } {
  const normalized = configDocuments(context)
    .filter((document) => Boolean(document.path && samePath(context.paths, document.path, servicePath)))
    .at(-1)?.plugins ?? []
  const noOpSafe = !rawPlugins.some(containsConfigVariable)
  let normalizedIndex = 0
  const pendingRules: string[] = []
  for (const entry of rawPlugins) {
    if (containsConfigVariable(entry)) {
      if (normalizedIndex < normalized.length) normalizedIndex += 1
      continue
    }
    if (normalizedIndex < normalized.length) {
      if (isDeepStrictEqual(entry, normalized[normalizedIndex])) normalizedIndex += 1
      continue
    }
    if (typeof entry !== "string") continue
    const selector = entry.startsWith("-") ? entry.slice(1) : entry
    if (!selector || !authorizedIds.some((id) => matchesSelector(selector, id))) continue
    pendingRules.push(entry)
  }
  return { plugins: [...normalized, ...pendingRules], noOpSafe }
}

function containsConfigVariable(value: unknown): boolean {
  if (typeof value === "string") return /\{(?:env|file):[^}]+\}/.test(value)
  if (Array.isArray(value)) return value.some(containsConfigVariable)
  return isRecord(value) && Object.values(value).some(containsConfigVariable)
}

function configDocuments(
  context: ReadContext,
  overlay?: { servicePath: string; plugins: readonly PluginConfigEntry[]; scope: PluginControlScope },
): ConfigDocumentView[] {
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
  return documents
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
    .map(({ sourceOrder: _sourceOrder, ...document }, order) => ({ ...document, order }))
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
  runtime: readonly PluginRuntimeInventoryEntry[],
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
  return runtime.find((entry) => entry.id && entry.source.type === "local"
    && (samePath(context.paths, localTarget, entry.source.path)
      || containsPath(context.paths, localTarget, entry.source.path)))?.id
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
