import { stat } from "node:fs/promises"
import path from "node:path"
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
  readPluginControlDocument,
  replacePluginControlDocument,
  type PluginConfigEntry,
  PluginControlDocumentError,
} from "./plugin-control-document"

type PluginControlsWorkspaceManager = Pick<WorkspaceManager,
  | "get"
  | "getSharedServiceConnection"
  | "ownsLocation"
  | "getWorktreeIdentityForPath"
  | "getServicePathStyle"
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
}

interface ResolvedTarget extends PluginControlTarget {
  hostPath: string
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
          document = await readPluginControlDocument(target.hostPath)
        } catch (error) {
          throw mapDocumentError(error)
        }
        const before = buildSnapshot(context, { servicePath: target.path, plugins: document.plugins, scope: request.scope })
        const control = before.controls.find((candidate) => candidate.id === request.pluginId)
        if (!control) throw new PluginControlsError("Plugin ID is not present in the authorized inventory", "forbidden")

        const desired: PluginScopeRuleState = request.enabled ? "enabled" : "disabled"
        if (control[request.scope] === desired) {
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
        assertCurrentConnection(context.connection)
        try {
          await replacePluginControlDocument(document, updated)
        } catch (error) {
          throw mapDocumentError(error)
        }
        target.exists = true
        const snapshot = buildSnapshot(context, {
          servicePath: target.path,
          plugins: [...document.plugins, rule],
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
    const location = normalizeLocation(input)
    const connection = await this.options.workspaceManager.getSharedServiceConnection(workspaceId)
    if (!connection) throw new PluginControlsError("OpenCode service is unavailable", "unavailable")
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
    const targets = await this.resolveTargets(workspaceId, paths, globalDirectory, location.directory)
    assertCurrentConnection(connection)
    return { connection, entries, runtime, location, paths, style, globalDirectory, targets }
  }

  private async resolveTargets(
    workspaceId: string,
    paths: path.PlatformPath,
    globalDirectory: string,
    projectDirectory: string,
  ): Promise<ResolvedTarget[]> {
    const [globalHost, projectHost] = await Promise.all([
      this.options.workspaceManager.getHostPathForServicePath(workspaceId, globalDirectory),
      this.options.workspaceManager.getHostPathForServicePath(workspaceId, projectDirectory),
    ])
    if (!globalHost || !projectHost || !path.isAbsolute(globalHost) || !path.isAbsolute(projectHost)) {
      throw new PluginControlsError("OpenCode configuration paths could not be mapped to the execution host", "unavailable")
    }
    return Promise.all([
      selectTarget("global", paths, globalDirectory, globalHost),
      selectTarget("project", paths, projectDirectory, projectHost),
    ])
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
        declaredTargets.add(entry.package)
        const runtimeId = runtimeSourceIds.get(entry.package)
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

      const runtimeSourceId = runtimeSourceIds.get(selector)
      const isFirstRuntimeSourceDeclaration = Boolean(runtimeSourceId && !declaredTargets.has(selector))
      const selectsPlugin = selector === "*" || selector.endsWith(".*") || selector.startsWith("opencode.")
        || (!isFirstRuntimeSourceDeclaration && knownDefinitions.has(selector))
      if (!selectsPlugin) {
        sources.push({ target: selector, scope: document.scope, path: document.path, entryIndex, hasOptions: false })
        declaredTargets.add(selector)
        if (runtimeSourceId) knownDefinitions.add(runtimeSourceId)
        return
      }
      rules.push({ selector, enabled: true, scope: document.scope, path: document.path, order: document.order, entryIndex })
    })
  }

  const ids = new Set([...runtimeIds, ...rules.flatMap((rule) => isExactSelector(rule.selector) ? [rule.selector] : [])])
  const controls = [...ids].filter(validPluginId).sort((left, right) => left.localeCompare(right)).map((id) => {
    const matching = rules.filter((rule) => matchesSelector(rule.selector, id))
    const controllingRule = matching.at(-1)
    return {
      id,
      runtime: runtime.find((entry) => entry.id === id),
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

async function selectTarget(
  scope: PluginControlScope,
  servicePaths: path.PlatformPath,
  serviceRoot: string,
  hostRoot: string,
): Promise<ResolvedTarget> {
  const relativeCandidates = scope === "global"
    ? ["opencode.json", "opencode.jsonc"]
    : ["opencode.json", "opencode.jsonc", servicePaths.join(".opencode", "opencode.json"), servicePaths.join(".opencode", "opencode.jsonc")]
  const candidates = relativeCandidates.map((relative) => ({
    servicePath: servicePaths.join(serviceRoot, relative),
    hostPath: path.join(hostRoot, ...relative.split(/[\\/]/)),
  }))
  let selected = candidates.at(-1)!
  let exists = false
  for (const candidate of candidates) {
    if (await pathExists(candidate.hostPath)) {
      selected = candidate
      exists = true
    }
  }
  return { scope, path: selected.servicePath, hostPath: selected.hostPath, exists }
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
  return paths.isAbsolute(value) && !value.includes("\0")
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

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw new PluginControlsError("Unable to inspect OpenCode configuration target", "unavailable", { cause: error })
  }
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
