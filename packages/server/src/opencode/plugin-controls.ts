import path from "node:path"
import { createHmac, randomBytes } from "node:crypto"
import { realpath } from "node:fs/promises"
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
  hostPluginControlDocumentFileSystem,
  readPluginControlDocument,
  replacePluginControlDocument,
  replacePluginControlRules,
  type PluginConfigEntry,
  type PluginControlDocument,
  type PluginControlDocumentFileSystem,
  type PluginControlDocumentPrepared,
  PluginControlDocumentError,
} from "./plugin-control-document"
import { createWslPluginControlDocumentFileSystem } from "./plugin-control-document-wsl"
import { readManagedDesktopPlugins, managedDesktopPluginForSource, type ManagedDesktopPlugin } from "./desktop-plugin-managed"
import { MISSIONS_PLUGIN_ID } from "../missions/plugin-id"
import { gitPluginRevision, PLUGIN_VERSIONS_RPC_ID, pluginVersionsSchema } from "./plugin-package-versions-contract"
import { definedBefore, enabledThrough, matchesSelector, type AppliedEntry, type AppliedSequence } from "./plugin-activation-order"
import { declaredEntrypointOf, discoveryEntrypointOf, discoveryEntrypointShape, discoveryLoaders, escapes, reportingEntries } from "./plugin-discovery-loaders"
import { pluginPackageIdentities } from "./plugin-source-document"

/** One writable target of a plugin-documents edit, with the snapshot's reading of it. `consistent`: the daemon's
 * entries equal the raw document (the condition `read` grants removal confirmation on), so its sources and rules
 * describe it; substitutions and watcher lag never authorize deletion. */
export interface PluginDocumentsTarget {
  scope: PluginControlScope
  document: PluginControlDocument
  /** Position in the applied order; absent when the daemon reports no document there yet. */
  order?: number
  consistent: boolean
  sources: PluginConfiguredSource[]
  rules: PluginConfiguredRule[]
}

/** Every applicable document's sources (sharing the targets' objects), every control, the applied order and the
 * location's writable targets. */
export interface PluginDocumentsView {
  allSources: PluginConfiguredSource[]
  controls: PluginActivationControl[]
  sequence: AppliedSequence
  targets: PluginDocumentsTarget[]
  /** Whether anything other than `source` may still load its plugin: an inventory entry of that ID it does not
   * correlate with (whatever its path), or a discovery child that maps to that ID or to none. True when unknown. */
  otherLoader(source: PluginConfiguredSource): boolean
}

export type NativeConfigDocuments = { location: PluginControlLocation; entries: ConfigEntry[];
  documents: Array<{ scope: PluginControlScope; path: string; document: PluginControlDocument }> }

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
  managedPlugins: ManagedDesktopPlugin[]
  packageVersions: Map<string, { revision: string; version: string }>
  /** Write decisions only: discovered entrypoints that exist as regular files now. Absent for display reads. */
  existingEntrypoints?: ReadonlySet<string>
  /** The plugin(s)/ folder children and the IDs each maps to (`discoveryLoaders`); absent or undefined: unknown. */
  discoveryLoaders?: string[][]
  /** The plugin each explicit local declaration (by resolved target) provably loads, and the inventory paths reporting
   * it. A target without an entry is unidentified. */
  localIdentities: Map<string, { id: string; paths: string[] }>
}

interface ResolvedTarget extends PluginControlTarget {
  ioPath: string
  requestedIoPath: string
  ioPaths: path.PlatformPath
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
  private readonly revisionKey = randomBytes(32)
  private readonly connectionIdentities = new WeakMap<object, string>()

  constructor(private readonly options: {
    workspaceManager: PluginControlsWorkspaceManager
    worktreeDeletionFence: PluginControlsMutationFence
    logger: Logger
  }) {}

  async read(workspaceId: string, location: PluginControlLocation, signal?: AbortSignal): Promise<PluginControlsSnapshot> {
    const context = await this.readContext(workspaceId, location, signal)
    let snapshot = buildSnapshot(context)
    // Orphan needs the discovery listing; list only when some control could be orphan (no loaded, managed or builtin
    // definition). Without it (WSL, read error), no control is orphan.
    if (snapshot.controls.some(control => !control.runtime && !control.managedBy && !control.builtin)) {
      context.discoveryLoaders = await this.discoveryLoaders(workspaceId, context)
      assertCurrentConnection(context.connection)
      snapshot = buildSnapshot(context)
    }
    const documents = configDocuments(context).documents
    await Promise.all(context.targets.map(async target => {
      try {
        const document = await readPluginControlDocument(target.ioPath, context.fileSystem)
        const normalized = documents.find(entry => entry.path && samePath(context.paths, entry.path, target.path))
        // Pair the displayed daemon declaration with the exact raw document. Substitutions and
        // watcher lag must never authorize removal of different options at the same index.
        if (!document.exists || !normalized || !isDeepStrictEqual(normalized.plugins, document.plugins)) return
        snapshot.targets.find(entry => entry.scope === target.scope)!.expectedRevision = this.documentRevision(workspaceId, context, target, document)
      } catch { /* Inventory remains readable; an unverifiable document has no removal authority. */ }
    }))
    assertCurrentConnection(context.connection)
    signal?.throwIfAborted()
    return snapshot
  }

  // Shared scope acquisition for native settings that have no native write API.
  // Callers receive only the already-authorized documents; path/WSL selection,
  // deletion admission, connection fencing and atomic conflict checks stay here.
  async readConfigDocuments(workspaceId: string, location: PluginControlLocation, signal?: AbortSignal, strictDocuments = false) {
    const context = await this.readContext(workspaceId, location, signal, strictDocuments)
    const documents = await Promise.all(context.targets.map(async target => ({
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
    edit: (document: PluginControlDocument, current: { entries: ConfigEntry[]; path: string; location: PluginControlLocation }) => string | Promise<string>,
    // Aborts the daemon reads and, re-checked under the lock, the commit itself.
    signal?: AbortSignal,
    strictDocuments = false,
    expectedRevision?: string,
  ): Promise<void> {
    const directory = location.directory.trim().replace(/[\\/]+$/, "").toLowerCase()
    const key = scope === "global" ? `${workspaceId}\nglobal` : `${workspaceId}\nproject\n${directory}`
    return this.serializeMutation(key, async () => {
      const context = await this.readContext(workspaceId, location, signal, strictDocuments)
      const target = context.targets.find(target => target.scope === scope)
      if (!target) throw new PluginControlsError("OpenCode configuration scope is unavailable", "unavailable")
      const identity = await this.options.workspaceManager.getWorktreeIdentityForPath(workspaceId, context.location.directory)
      if (!identity) throw new PluginControlsError("Location is not owned by an active worktree", "forbidden")
      const release = this.options.worktreeDeletionFence.enter([identity])
      if (!release) throw new PluginControlsError("Worktree deletion is in progress", "conflict")
      try {
        const document = await readPluginControlDocument(target.ioPath, context.fileSystem)
        if (expectedRevision !== undefined && expectedRevision !== this.documentRevision(workspaceId, context, target, document)) {
          throw new PluginControlDocumentError("OpenCode configuration changed since confirmation", "conflict")
        }
        const updated = await edit(document, { entries: context.entries, path: target.path, location: context.location })
        await replacePluginControlDocument(document, updated, {
          beforeCommit: () => { assertCurrentConnection(context.connection); signal?.throwIfAborted() },
        }, context.fileSystem)
      } catch (error) { throw error instanceof PluginControlDocumentError ? mapDocumentError(error) : error }
      finally { release() }
    })
  }

  /**
   * One plugin-source edit over the location's writable documents: `expectedRevision` confirms `scope`'s document,
   * `edit` returns the new text of each target it changes, and every changed file is prepared and verified before the
   * first rename, so a refusal writes nothing. Global and Project queues are held in that fixed order.
   */
  editPluginDocuments(workspaceId: string, location: PluginControlLocation, scope: PluginControlScope, expectedRevision: string,
    edit: (view: PluginDocumentsView) => Partial<Record<PluginControlScope, string>>): Promise<void> {
    const directory = location.directory.trim().replace(/[\\/]+$/, "").toLowerCase()
    return this.serializeMutation(`${workspaceId}\nglobal`, () => this.serializeMutation(`${workspaceId}\nproject\n${directory}`, async () => {
      const context = await this.readContext(workspaceId, location)
      if (!context.targets.some(target => target.scope === scope)) throw new PluginControlsError("OpenCode configuration scope is unavailable", "unavailable")
      if (!context.fileSystem.prepare) throw new PluginControlsError("Prepared configuration editing is unavailable", "unavailable")
      const identity = await this.options.workspaceManager.getWorktreeIdentityForPath(workspaceId, context.location.directory)
      if (!identity) throw new PluginControlsError("Location is not owned by an active worktree", "forbidden")
      const release = this.options.worktreeDeletionFence.enter([identity])
      if (!release) throw new PluginControlsError("Worktree deletion is in progress", "conflict")
      const prepared: Array<{ scope: PluginControlScope; write: PluginControlDocumentPrepared }> = []
      try {
        await this.verifyDiscoveredEntrypoints(workspaceId, context)
        const documents = await Promise.all(context.targets.map(async target => ({ target, document: await readPluginControlDocument(target.ioPath, context.fileSystem) })))
        const confirmed = documents.find(entry => entry.target.scope === scope)!
        if (expectedRevision !== this.documentRevision(workspaceId, context, confirmed.target, confirmed.document)) {
          throw new PluginControlDocumentError("OpenCode configuration changed since confirmation", "conflict")
        }
        context.discoveryLoaders = await this.discoveryLoaders(workspaceId, context)
        assertCurrentConnection(context.connection)
        const { snapshot, sequence, documents: applied } = evaluateDocuments(snapshotBase(context), context)
        const at = (item: { path?: string }, path: string) => Boolean(item.path && samePath(context.paths, item.path, path))
        const otherLoader = (source: PluginConfiguredSource) => !source.pluginId
          || anotherLoader(context, snapshot.configured.sources, snapshot.runtime, source.pluginId, source)
        const updates = edit({ allSources: snapshot.configured.sources, controls: snapshot.controls, sequence, otherLoader,
          targets: documents.map(({ target, document }) => {
            const normalized = applied.find(entry => at(entry, target.path))
            return { scope: target.scope, document, ...(normalized ? { order: normalized.order } : {}),
              consistent: Boolean(document.exists && normalized && isDeepStrictEqual(normalized.plugins, document.plugins)),
              sources: snapshot.configured.sources.filter(source => at(source, target.path)),
              rules: snapshot.configured.rules.filter(rule => at(rule, target.path)) }
          }) })
        // Physical ordering is shared with other batches to avoid lock inversion.
        const changed = documents.filter(({ target }) => updates[target.scope] !== undefined)
          .sort((left, right) => left.document.writePath < right.document.writePath ? -1 : 1)
        for (const { target, document } of changed) {
          assertCurrentConnection(context.connection)
          prepared.push({ scope: target.scope, write: await context.fileSystem.prepare(document, updates[target.scope]!,
            { beforeCommit: () => assertCurrentConnection(context.connection) }) })
        }
        for (const { write } of prepared) await write.verify()
        // Locks follow physical order; commits follow safety order. The confirmed document (the source removal)
        // commits last, after the cleanups that depend on it, so a failure in between leaves a configuration where
        // every bare ID still follows its definition.
        for (const { write } of [...prepared].sort((left, right) => Number(left.scope === scope) - Number(right.scope === scope))) {
          assertCurrentConnection(context.connection)
          await write.commit()
        }
      } catch (error) { throw error instanceof PluginControlDocumentError ? mapDocumentError(error) : error }
      finally {
        await Promise.allSettled(prepared.map(({ write }) => write.dispose()))
        release()
      }
    }))
  }

  /**
   * For a write decision, keeps the reported local entrypoints that native discovery selects right now: the child's
   * single entrypoint (`discoveryEntrypointOf`) must be that very file, as named or after resolving links. A deleted
   * folder, a `server` module taking precedence over a reported `index`, or an uncertain selection (read error, WSL,
   * which has no host listing here) defines nothing, so no bare ID is written for it.
   */
  private async verifyDiscoveredEntrypoints(workspaceId: string, context: ReadContext): Promise<void> {
    const folders = discoveryFolders(context)
    const existing = new Set<string>()
    if (!this.options.workspaceManager.getServiceWslDistro(workspaceId)) {
      const reported = [...new Set(context.runtime.flatMap(entry => entry?.source?.type === "local" && typeof entry.source.path === "string"
        ? [entry.source.path] : []))]
      await Promise.all(reported.map(async file => {
        const child = discoveryChild(context.paths, folders, file)
        if (!child) return
        try {
          const [hostChild, hostFile] = await Promise.all([child, file].map(value => this.options.workspaceManager.getHostPathForServicePath(workspaceId, value)))
          const selected = hostChild ? await discoveryEntrypointOf(hostChild) : undefined
          if (!selected || !hostFile) return
          if (selected === hostFile || await realpath(selected) === await realpath(hostFile)) existing.add(file)
        } catch { /* Unverifiable: not a definition. */ }
      }))
    }
    assertCurrentConnection(context.connection)
    context.existingEntrypoints = existing
  }

  /** The discovery children of the reported plugin(s)/ folders and the IDs each maps to; `undefined` when they cannot
   * be listed with certainty, including through WSL, which has no listing primitive here. */
  private async discoveryLoaders(workspaceId: string, context: ReadContext): Promise<string[][] | undefined> {
    if (this.options.workspaceManager.getServiceWslDistro(workspaceId)) return undefined
    try {
      return await discoveryLoaders({
        folders: discoveryFolders(context),
        hostPath: servicePath => this.options.workspaceManager.getHostPathForServicePath(workspaceId, servicePath),
        inventory: context.runtime.flatMap(entry => typeof entry?.id === "string" && entry.source?.type === "local"
          && typeof entry.source.path === "string" ? [{ id: entry.id, path: entry.source.path }] : []),
        managedIds: child => managedDesktopPluginForSource(context.managedPlugins, child, context.paths)?.ids ?? [],
        serviceJoin: (folder, name) => context.paths.join(folder, name),
      })
    } catch {
      return undefined
    }
  }

  private documentRevision(workspaceId: string, context: ReadContext, target: ResolvedTarget, document: PluginControlDocument): string {
    let connection = this.connectionIdentities.get(context.connection.client)
    if (!connection) { connection = randomBytes(16).toString("hex"); this.connectionIdentities.set(context.connection.client, connection) }
    return createHmac("sha256", this.revisionKey).update(JSON.stringify([
      workspaceId, context.location, target.scope, target.path, document.requestedPath, document.writePath,
      this.options.workspaceManager.getServiceWslDistro(workspaceId) ?? null, connection,
      document.exists, document.mode, document.byteOrderMark, document.text,
    ])).digest("hex")
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
        await this.verifyDiscoveredEntrypoints(workspaceId, context)
        // The response snapshot classifies orphan IDs with the same discovery proof as reads.
        context.discoveryLoaders = await this.discoveryLoaders(workspaceId, context)
        const exact = request.scope === "global" && request.pluginId === MISSIONS_PLUGIN_ID && request.managedBy === "codenomad"
        let document
        try {
          document = await readPluginControlDocument(exact ? target.requestedIoPath : target.ioPath, context.fileSystem)
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
        if (!control || request.managedBy && control.managedBy !== request.managedBy) {
          throw new PluginControlsError("Plugin ID is not present in the authorized inventory", "forbidden")
        }
        // OpenCode does not observe replacement of the destination of a linked config.
        if (exact && !samePath(target.ioPaths, target.requestedIoPath, document.writePath)) {
          throw new PluginControlsError("Missions activation requires a direct OpenCode global configuration file", "unavailable")
        }

        const desired: PluginScopeRuleState = request.enabled ? "enabled" : "disabled"
        const rule = request.enabled ? request.pluginId : `-${request.pluginId}`
        const exactGlobal = (snapshot: PluginControlsSnapshot, plugins: readonly PluginConfigEntry[]) => {
          const deciding = snapshot.configured.rules.filter(rule => rule.scope === "global" && matchesSelector(rule.selector, request.pluginId)).at(-1)
          return deciding?.path && samePath(context.paths, deciding.path, target.path) && plugins[deciding.entryIndex] === rule
        }
        assertCurrentConnection(context.connection)
        if (projection.noOpSafe && control[request.scope] === desired && (!exact || exactGlobal(before, document.plugins))) {
          return {
            snapshot: before,
            rule,
            target: publicTarget(target),
            changed: false,
            reloadPending: false,
          }
        }

        const removable = projection.noOpSafe
          ? replaceableRuleIndexes(document.plugins, projection.plugins, before, target.path, request.scope, request.pluginId, context.paths) : []
        const kept = projection.plugins.filter((_, index) => !removable.includes(index))
        // Candidates in OpenCode's applied order, smallest first: delete this scope's exact rules, replace them, append.
        // One qualifies when the scope's state (every document through its last one, wildcards included) is the requested
        // one, and any bare `id` it writes follows a verified definition: otherwise OpenCode would install the registry
        // package of that name. Nothing qualifying is refused before any write.
        let edit: { remove: number[]; rule?: string; snapshot: PluginControlsSnapshot } | undefined
        for (const candidate of [...removable.length > 0 ? [{ remove: removable }, { remove: removable, rule }] : [], { remove: [] as number[], rule }]) {
          if (exact && candidate.rule === undefined) continue
          const plugins = candidate.rule === undefined ? kept : [...(candidate.remove.length > 0 ? kept : projection.plugins), candidate.rule]
          const evaluated = evaluateDocuments(base, context, { servicePath: target.path, plugins, scope: request.scope })
          const position = evaluated.documents.find(entry => entry.path && samePath(context.paths, entry.path, target.path))!.order
          const through = Math.max(...evaluated.documents.filter(entry => entry.scope === request.scope).map(entry => entry.order))
          if (candidate.rule !== undefined && request.enabled
            && !definedBefore(evaluated.sequence, request.pluginId, position, plugins.length - 1)) continue
          if (enabledThrough(evaluated.sequence, request.pluginId, through) !== request.enabled) continue
          if (exact && !exactGlobal(evaluated.snapshot, plugins)) continue
          edit = { ...candidate, snapshot: evaluated.snapshot }
          break
        }
        if (!edit) throw new PluginControlsError("OpenCode's plugin order cannot reach this state without a package spec", "forbidden")
        const updated = replacePluginControlRules(document, edit.remove, new Set([request.pluginId, `-${request.pluginId}`]), edit.rule)
        try {
          await replacePluginControlDocument(document, updated, {
            beforeCommit: () => assertCurrentConnection(context.connection),
          }, context.fileSystem)
        } catch (error) {
          throw mapDocumentError(error)
        }
        target.exists = true
        this.options.logger.info({ workspaceId, scope: request.scope, pluginId: request.pluginId, removed: edit.remove.length,
          appended: edit.rule !== undefined }, "Updated OpenCode plugin activation rule")
        return { snapshot: edit.snapshot, rule, target: publicTarget(target), changed: true, reloadPending: true }
      } finally {
        release()
      }
    })
  }

  private async readContext(workspaceId: string, input: PluginControlLocation, signal?: AbortSignal, strictDocuments = false): Promise<ReadContext> {
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
    // A caller's signal (bounded reads such as extension status) also cancels the native reads.
    const requestOptions = signal ? { ...locationRequestOptions(location), signal } : locationRequestOptions(location)
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
    const targets = await this.resolveTargets(workspaceId, paths, globalDirectory, location.directory, entries, fileSystem, Boolean(distro), strictDocuments)
    const managedPlugins = await readManagedDesktopPlugins({ globalDirectory, paths,
      hostPath: nativePath => this.options.workspaceManager.getHostPathForServicePath(workspaceId, nativePath),
      assertCurrent: () => { assertCurrentConnection(connection); signal?.throwIfAborted() },
    })
    const packageVersions = new Map<string, { revision: string; version: string }>()
    if (runtime.some(entry => entry?.source?.type === "package" && gitPluginRevision(entry.source.target, entry.source.version))) {
      try {
        const response = await connection.client.rpc.call({ rpcID: PLUGIN_VERSIONS_RPC_ID, method: "list", input: {}, location: requestLocation },
          { ...requestOptions, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(2500)]) })
        const parsed = pluginVersionsSchema.safeParse(response.output)
        if (parsed.success) for (const entry of parsed.data) packageVersions.set(entry.target, entry)
      } catch { /* Optional display metadata: the native commit remains available. */ }
    }
    const localIdentities = await this.localIdentities(workspaceId, { entries, runtime, location, paths, style })
    assertCurrentConnection(connection)
    signal?.throwIfAborted()
    return { connection, entries, runtime, location, paths, style, globalDirectory, targets, fileSystem, managedPlugins, packageVersions, localIdentities }
  }

  /**
   * Which plugin each explicit local declaration provably loads: an inventory entry identifies it only when its path
   * is the declaration's single selected entrypoint (`declaredEntrypointOf`, as named or after resolving links);
   * containment or a sibling module identifies nothing, and several IDs at that entrypoint leave it unidentified.
   * Host file system only: through WSL, local declarations stay unidentified.
   */
  private async localIdentities(workspaceId: string, context: Pick<ReadContext, "entries" | "runtime" | "location" | "paths" | "style">):
    Promise<Map<string, { id: string; paths: string[] }>> {
    const identities = new Map<string, { id: string; paths: string[] }>()
    if (this.options.workspaceManager.getServiceWslDistro(workspaceId)) return identities
    const targets = new Set<string>()
    for (const entry of context.entries) {
      if (entry?.type !== "document") continue
      for (const plugin of normalizePluginEntries(entry.info?.plugins)) {
        const target = typeof plugin === "string" ? (plugin.startsWith("-") ? undefined : plugin) : plugin.package
        const local = target ? configuredLocalTarget(context, typeof entry.path === "string" ? entry.path : undefined, target) : undefined
        if (local) targets.add(local)
      }
    }
    if (targets.size === 0) return identities
    const host = (value: string) => this.options.workspaceManager.getHostPathForServicePath(workspaceId, value).catch(() => undefined)
    const inventory = await Promise.all(context.runtime.flatMap(entry => typeof entry?.id === "string" && entry.source?.type === "local"
      && typeof entry.source.path === "string" ? [{ id: entry.id, service: entry.source.path }] : []).map(async entry => {
      const path = await host(entry.service)
      return path ? { ...entry, path, real: await realpath(path).catch(() => path) } : undefined
    }))
    await Promise.all([...targets].map(async target => {
      try {
        const hostTarget = await host(target)
        const selected = hostTarget ? await declaredEntrypointOf(hostTarget) : undefined
        if (!selected) return
        const reporting = await reportingEntries(selected, inventory)
        const ids = new Set(reporting.map(entry => entry.id))
        if (ids.size === 1) identities.set(target, { id: [...ids][0]!, paths: reporting.map(entry => entry.service) })
      } catch { /* Unidentified. */ }
    }))
    return identities
  }

  private async resolveTargets(
    workspaceId: string,
    paths: path.PlatformPath,
    globalDirectory: string,
    projectDirectory: string,
    entries: readonly ConfigEntry[],
    fileSystem: PluginControlDocumentFileSystem,
    nativeWsl: boolean,
    strictDocuments: boolean,
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
    if (strictDocuments) {
      // Native settings require one unambiguous document per layer; never pick a
      // JSONC file while a simultaneous JSON writer owns the same native layer.
      for (let index = 0; index < inspected.length; index += 2) {
        if (inspected[index]?.exists && inspected[index + 1]?.exists)
          throw new PluginControlsError("OpenCode configuration changed: JSON and JSONC coexist in one layer", "conflict")
      }
    }
    const globalTarget = selectTarget("global", globalCandidates, inspected.slice(0, globalCandidates.length), ioPaths)
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
      ? selectTarget("project", projectCandidates.slice(2), projectInspected.slice(2), ioPaths)
      : selectTarget("project", projectCandidates, projectInspected, ioPaths)
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
  const runtime = context.runtime.map((entry, index) => normalizeRuntimeEntry(entry, index, context.packageVersions)).map(entry => entry.source.type === "local"
    && managedDesktopPluginForSource(context.managedPlugins, entry.source.path, context.paths)
    ? { ...entry, managedBy: "codenomad" as const } : entry)
  const runtimeIds = new Set<string>()
  const runtimeSourceIds = new Map<string, string>()
  const runtimeById = new Map<string, PluginRuntimeInventoryEntry>()
  for (const entry of runtime) {
    if (!entry.id) continue
    // Duplicate IDs are invalid daemon output; keep first-wins attachment so a
    // repeated entry cannot displace the inventory record already published.
    if (!runtimeById.has(entry.id)) runtimeById.set(entry.id, entry)
    runtimeIds.add(entry.id)
    // Package targets only: local declarations are identified by their selected entrypoint (`localIdentities`).
    if (entry.source.type === "package") runtimeSourceIds.set(entry.source.target, entry.id)
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
  return evaluateDocuments(base, context, overlay).snapshot
}

/** The snapshot and OpenCode's applied order of the same documents. */
function evaluateDocuments(
  base: SnapshotBase,
  context: ReadContext,
  overlay?: { servicePath: string; plugins: readonly PluginConfigEntry[]; scope: PluginControlScope },
): { snapshot: PluginControlsSnapshot; sequence: AppliedSequence; documents: readonly ConfigDocumentView[] } {
  const { runtime, runtimeIds, runtimeSourceIds, runtimeById } = base
  const documents = overlay ? applyOverlay(base, context, overlay) : base.documents
  // IDs only associate rules after an installation has passed local provenance checks.
  // A runtime homonym from another source retains its ordinary controls.
  const managedIds = new Set(context.managedPlugins.flatMap(entry => entry.ids)
    .filter(id => !runtimeById.has(id) || runtimeById.get(id)?.managedBy === "codenomad"))
  // Defined before every document, as OpenCode applies discovery first: builtin and SDK plugins, plugins native
  // discovery loads from a reported configuration directory's plugin(s)/ folder, and verified descriptors. Any other
  // undeclared inventory entry (a declaration the daemon is still reloading) defines nothing.
  // A write decision also requires the entrypoint to exist: an inventory entry can outlive its deleted folder.
  const discovery = discoveryFolders(context)
  const startIds = new Set([...runtime.flatMap(entry => entry.id && (entry.source.type === "builtin" || entry.source.type === "sdk"
    || (entry.source.type === "local" && discoveredEntrypoint(context.paths, discovery, entry.source.path)
      && (!context.existingEntrypoints || context.existingEntrypoints.has(entry.source.path))))
    ? [entry.id] : []), ...managedIds])
  // Positive entries select only IDs defined before them in the applied order; a `-id` rule defines nothing.
  const knownDefinitions = new Set(startIds)
  // Targets OpenCode reports loading as packages, including failures that exported no ID: such an entry is a source,
  // whatever ID an earlier rule names.
  const reportedTargets = new Set(runtime.flatMap(entry => entry.source.type === "package" ? [entry.source.target] : []))
  const declaredTargets = new Set<string>()
  const rules: PluginConfiguredRule[] = []
  const sources: PluginConfiguredSource[] = []
  const applied: AppliedEntry[] = []
  for (const document of documents) {
    document.plugins.forEach((entry, entryIndex) => {
      if (typeof entry !== "string") {
        const runtimeId = runtimeIdForConfiguredTarget(context, document, entry.package, runtimeById, runtimeSourceIds)
        applied.push({ document: document.order, entryIndex, remove: false, target: entry.package, ...(runtimeId ? { pluginId: runtimeId } : {}) })
        sources.push({ target: entry.package, scope: document.scope, path: document.path, entryIndex, hasOptions: entry.options !== undefined,
          ...(runtimeId ? { pluginId: runtimeId } : {}) })
        const isFirstRuntimeSourceDeclaration = Boolean((runtimeId || reportedTargets.has(entry.package)) && !declaredTargets.has(entry.package))
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
      const step: AppliedEntry = { document: document.order, entryIndex, remove: disabled, target: selector }
      applied.push(step)
      if (disabled) {
        rules.push({ selector, enabled: false, scope: document.scope, path: document.path, order: document.order, entryIndex })
        return
      }

      const runtimeSourceId = runtimeIdForConfiguredTarget(context, document, selector, runtimeById, runtimeSourceIds)
      const isFirstRuntimeSourceDeclaration = Boolean((runtimeSourceId || reportedTargets.has(selector)) && !declaredTargets.has(selector))
      const selectsPlugin = selector === "*" || selector.endsWith(".*") || selector.startsWith("opencode.")
        || (!isFirstRuntimeSourceDeclaration && knownDefinitions.has(selector))
      if (!selectsPlugin) {
        sources.push({ target: selector, scope: document.scope, path: document.path, entryIndex, hasOptions: false,
          ...(runtimeSourceId ? { pluginId: runtimeSourceId } : {}) })
        if (runtimeSourceId) step.pluginId = runtimeSourceId
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

  for (const source of sources) {
    const nativeSource = source.target.startsWith("./") || source.target.startsWith("../")
      ? context.paths.resolve(source.path ? context.paths.dirname(source.path) : context.location.directory, source.target) : source.target
    if (managedDesktopPluginForSource(context.managedPlugins, nativeSource, context.paths)) source.managedBy = "codenomad"
  }
  const ids = new Set<string>([...runtimeIds, ...managedIds])
  for (const rule of rules) {
    if (isExactSelector(rule.selector)) ids.add(rule.selector)
  }
  const controls = [...ids].filter(validPluginId).sort(controlIdCollator.compare).map((id) => {
    const matching = rules.filter((rule) => matchesSelector(rule.selector, id))
    const controllingRule = matching.at(-1)
    const runtimeEntry = runtimeById.get(id) ?? runtime.find(entry => !entry.id && entry.managedBy === "codenomad"
      && entry.source.type === "local"
      && managedDesktopPluginForSource(context.managedPlugins, entry.source.path, context.paths)?.ids.includes(id))
    const managed = runtimeEntry?.managedBy === "codenomad" || managedIds.has(id)
    const builtin = runtimeEntry?.source.type === "builtin" || id.startsWith("opencode.")
    return {
      id,
      ...(managed ? { managedBy: "codenomad" as const } : {}),
      ...(runtimeEntry ? { runtime: runtimeEntry } : {}),
      builtin,
      effective: stateForRule(controllingRule),
      global: stateForRule(matching.filter((rule) => rule.scope === "global").at(-1)),
      project: stateForRule(matching.filter((rule) => rule.scope === "project").at(-1)),
      ...(controllingRule ? { controllingRule } : {}),
      ...(!runtimeEntry && !managed && !builtin && !anotherLoader(context, sources, runtime, id) ? { orphan: true as const } : {}),
    } satisfies PluginActivationControl
  })
  return {
    snapshot: { location: context.location, runtime, configured: { rules, sources }, controls, targets: context.targets.map(publicTarget) },
    sequence: { entries: applied, startIds },
    documents,
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

/**
 * Entries of the target document that are exact `id`/`-id` activation rules for `pluginId`, safe to delete: the raw
 * document must equal the daemon's projection entry by entry (callers also require a no-op-safe projection, so
 * placeholders and watcher lag keep the plain append), and an entry the snapshot
 * reads as a source declaration (a package named like its ID) is never a rule.
 */
function replaceableRuleIndexes(
  rawPlugins: readonly PluginConfigEntry[],
  projected: readonly PluginConfigEntry[],
  snapshot: PluginControlsSnapshot,
  servicePath: string,
  scope: PluginControlScope,
  pluginId: string,
  paths: path.PlatformPath,
): number[] {
  if (rawPlugins.length !== projected.length) return []
  if (rawPlugins.some((entry, index) => !pluginEntriesEqual(entry, projected[index]))) return []
  const sources = new Set(snapshot.configured.sources
    .filter(source => source.scope === scope && source.path && samePath(paths, source.path, servicePath))
    .map(source => source.entryIndex))
  return rawPlugins.flatMap((entry, index) =>
    (entry === pluginId || entry === `-${pluginId}`) && projected[index] === entry && !sources.has(index) ? [index] : [])
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
  ioPaths: path.PlatformPath,
): ResolvedTarget {
  if (candidates.length !== inspected.length) {
    throw new PluginControlsError("OpenCode configuration target inspection was incomplete", "unavailable")
  }
  let selectedIndex = candidates.length - 1
  candidates.forEach((candidate, index) => {
    if (inspected[index]!.exists) selectedIndex = index
  })
  const selected = candidates[selectedIndex]!, resolved = inspected[selectedIndex]!
  return { scope, path: selected.servicePath, ioPath: resolved.writePath, requestedIoPath: selected.ioPath, ioPaths, exists: resolved.exists }
}

function normalizeRuntimeEntry(plugin: PluginInfo, index: number, packageVersions: ReadContext["packageVersions"]): PluginRuntimeInventoryEntry {
  if (!isRecord(plugin) || !isRecord(plugin.state)) {
    throw new PluginControlsError("OpenCode returned an invalid plugin inventory", "unavailable")
  }
  const source = normalizeRuntimeSource(plugin.source, packageVersions)
  const id = typeof plugin?.id === "string" && validPluginId(plugin.id) ? plugin.id : undefined
  const features = isRecord(plugin?.features) ? {
    ...(plugin.features.server === true ? { server: true as const } : {}),
    ...(plugin.features.tui === true ? { tui: true as const } : {}),
    ...(plugin.features.rpc === true ? { rpc: true as const } : {}),
    ...(plugin.features.gui === true ? { gui: true as const } : {}),
  } : {}
  const state = plugin.state.status === "active"
    ? { status: "active" as const }
    : plugin.state.status === "failed" && typeof plugin.state.error === "string"
      ? { status: "failed" as const, error: plugin.state.error, ...(typeof plugin.state.ref === "string" ? { ref: plugin.state.ref } : {}) }
      : undefined
  if (!state) throw new PluginControlsError("OpenCode returned an invalid plugin inventory", "unavailable")
  return { key: id ?? `${source.type}:${sourceDetail(source)}:${index}`, ...(id ? { id } : {}), source, features, state }
}

function normalizeRuntimeSource(source: unknown, packageVersions: ReadContext["packageVersions"]): PluginRuntimeSource {
  if (!isRecord(source)) throw new PluginControlsError("OpenCode returned an invalid plugin source", "unavailable")
  if (source.type === "builtin") return { type: "builtin" }
  if (source.type === "sdk") return { type: "sdk" }
  if (source.type === "local" && typeof source.path === "string" && source.path) return { type: "local", path: source.path }
  if (source.type === "package" && typeof source.target === "string" && source.target) {
    const revision = gitPluginRevision(source.target, typeof source.version === "string" ? source.version : undefined)
    const installed = packageVersions.get(source.target)
    const version = revision ? (installed?.revision === revision ? installed.version : revision.slice(0, 7)) : source.version
    return {
      type: "package",
      target: source.target,
      ...(typeof version === "string" ? { version } : {}),
      ...(revision ? { revision } : {}),
      ...(source.outdated === true ? { outdated: true as const } : {}),
      ...(source.updating === true ? { updating: true as const } : {}),
    }
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
  // Classify first, as OpenCode does: a target resolving to an absolute path (file URL, ./ ../, absolute) is a local
  // declaration and is identified only through a verified descriptor or its selected entrypoint; anything else is a
  // package, identified by its exact native target. No raw-target shortcut crosses the two.
  const localTarget = configuredLocalTarget(context, document.path, target)
  if (!localTarget) return direct.get(target)
  const installation = managedDesktopPluginForSource(context.managedPlugins, localTarget, context.paths)
  if (installation) {
    // The daemon may report the shim while configuration names its referenced bundle (or vice versa).
    for (const entry of runtimeById.values()) {
      if (entry.managedBy === "codenomad" && entry.source.type === "local"
        && managedDesktopPluginForSource(context.managedPlugins, entry.source.path, context.paths) === installation) return entry.id
    }
    if (installation.ids.length === 1 && !runtimeById.has(installation.ids[0])) return installation.ids[0]
  }
  // Only the inventory entry reporting the declaration's selected entrypoint identifies it, never a module inside it.
  return context.localIdentities.get(localTarget)?.id
}

/**
 * The one proof every `-id` deletion needs (rule-only removal through `orphan`, and source removal): whether anything
 * other than the removed source `except` may still load `id`. Possible loaders: another document declaration of the
 * plugin (same `pluginId`, target or package identity), any declaration without an exported ID (it may define any
 * ID), an inventory entry of `id` that `except` does not account for (whatever its path), and a discovery child that
 * maps to `id` or to no ID. True when the discovery listing is unknown: uncertainty keeps `-id`.
 */
function anotherLoader(context: ReadContext, sources: readonly PluginConfiguredSource[], runtime: readonly PluginRuntimeInventoryEntry[],
  id: string, except?: PluginConfiguredSource): boolean {
  const identities = new Set(except ? pluginPackageIdentities(except.target) : [])
  if (sources.some(other => other !== except && (!other.pluginId || other.pluginId === id || (except !== undefined
    && (other.target === except.target || pluginPackageIdentities(other.target).some(identity => identities.has(identity))))))) return true
  const local = except && configuredLocalTarget(context, except.path, except.target)
  // The removed source accounts only for the entries reporting its own selected entrypoint (or its package target).
  const accounted = (entry: PluginRuntimeInventoryEntry) => except !== undefined && (entry.source.type === "package"
    ? entry.source.target === except.target
    : entry.source.type === "local" && Boolean(local && context.localIdentities.get(local)?.paths.includes(entry.source.path)))
  if (runtime.some(entry => entry.id === id && !accounted(entry))) return true
  const loaders = context.discoveryLoaders
  return loaders === undefined || loaders.some(ids => ids.length === 0 || ids.includes(id))
}

/** The native path a local declaration names (`file://`, relative to its document, or absolute), as OpenCode resolves it. */
function configuredLocalTarget(context: Pick<ReadContext, "style" | "paths" | "location">, documentPath: string | undefined, target: string): string | undefined {
  try {
    if (target.startsWith("file://")) return fileURLToPath(target, { windows: context.style === "win32" })
    if (target.startsWith("./") || target.startsWith("../")) {
      return context.paths.resolve(documentPath ? context.paths.dirname(documentPath) : context.location.directory, target)
    }
    return context.paths.isAbsolute(target) ? target : undefined
  } catch {
    return undefined
  }
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

function discoveryFolders(context: ReadContext): string[] {
  return context.entries.flatMap(entry => entry?.type === "directory" && typeof entry.path === "string"
    ? ["plugin", "plugins"].map(name => context.paths.join(entry.path, name)) : [])
}

/**
 * The immediate plugin(s)/ folder child whose entrypoint `file` could be (`discoveryEntrypointShape`), or `undefined`.
 * Display uses the shape alone; write decisions also require `discoveryEntrypointOf` to select exactly `file`.
 */
function discoveryChild(paths: path.PlatformPath, folders: readonly string[], file: string): string | undefined {
  for (const folder of folders) {
    const relative = paths.relative(folder, file)
    if (!relative || escapes(paths, relative)) continue
    const child = paths.join(folder, relative.split(/[\\/]/)[0]!)
    if (discoveryEntrypointShape(paths, child, file)) return child
  }
  return undefined
}

function discoveredEntrypoint(paths: path.PlatformPath, folders: readonly string[], file: string): boolean {
  return discoveryChild(paths, folders, file) !== undefined
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
