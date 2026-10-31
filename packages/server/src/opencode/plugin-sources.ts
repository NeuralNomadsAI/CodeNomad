import type { PluginControlsSnapshot } from "../api-types"
import type { Logger } from "../logger"
import type {
  PluginSourceAddRequest,
  PluginSourceErrorCode,
  PluginSourceMutationResponse,
  PluginSourceRemoveRequest,
} from "../plugin-source-types"
import { appendPluginControlRule, PluginControlDocumentError } from "./plugin-control-document"
import { PluginControlsError, type PluginControls, type PluginControlsErrorKind } from "./plugin-controls"
import {
  pluginEntryTarget,
  pluginPackageIdentities,
  PluginSourceSpecError,
  removePluginSourceEntry,
  validatePluginSourceSpec,
} from "./plugin-source-document"

export class PluginSourcesError extends PluginControlsError {
  constructor(message: string, kind: PluginControlsErrorKind, readonly code: PluginSourceErrorCode) {
    super(message, kind)
    this.name = "PluginSourcesError"
  }
}

type Documents = Pick<PluginControls, "read" | "readConfigDocuments" | "editConfigDocument">

/** Bound on one queued add (its daemon reads and the write) before it is refused as unavailable. */
export const PLUGIN_SOURCE_ADD_TIMEOUT_MS = 20_000

/**
 * Source declarations (add/remove) on top of the shared fenced configuration-document
 * primitive: scope resolution, ownership, the deletion fence, connection fencing, JSONC
 * preservation, locks, atomic replacement and WSL all come from `editConfigDocument`.
 * The package cache is never touched; OpenCode reloads the watched document.
 */
export class PluginSources {
  // One queue for the whole server: the Global document is shared by every workspace.
  private addTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: { documents: Documents; logger: Logger; addTimeoutMs?: number }) {}

  add(workspaceId: string, request: PluginSourceAddRequest): Promise<PluginSourceMutationResponse> {
    try {
      validatePluginSourceSpec(request.spec)
    } catch (error) {
      return Promise.reject(error instanceof PluginSourceSpecError ? new PluginSourcesError(error.message, "invalid", error.code) : error)
    }
    // The duplicate check spans both scopes while the document lock covers one file:
    // serialize adds so a concurrent add in the other scope, from any workspace, is visible.
    // Each turn has a deadline, so one unresponsive OpenCode service cannot hold the queue.
    const result = this.addTail.then(() => this.withDeadline(signal => this.addSerialized(workspaceId, request, signal)))
    this.addTail = result.then(() => undefined, () => undefined)
    return result
  }

  private withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort()
        reject(new PluginSourcesError("OpenCode did not answer in time", "unavailable", "timeout"))
      }, this.options.addTimeoutMs ?? PLUGIN_SOURCE_ADD_TIMEOUT_MS)
      operation(controller.signal).then(resolve, reject).finally(() => clearTimeout(timer))
    })
  }

  private async addSerialized(workspaceId: string, request: PluginSourceAddRequest, signal: AbortSignal): Promise<PluginSourceMutationResponse> {
    const { spec, scope } = request
    const identities = new Set(pluginPackageIdentities(spec))
    const [snapshot, raw] = await Promise.all([
      this.options.documents.read(workspaceId, request.location, signal),
      this.options.documents.readConfigDocuments(workspaceId, request.location, signal),
    ])
    if (signal.aborted) throw new PluginSourcesError("OpenCode did not answer in time", "unavailable", "timeout")
    const ids = knownPluginIds(snapshot)
    // The daemon's documents cover every effective scope (Global, Project, inherited and
    // inline); the raw target documents also cover writes the daemon has not reloaded yet.
    assertNotDeclared(snapshot.configured.sources.map(source => source.target), identities, new Set())
    assertNotDeclared(raw.documents.flatMap(({ document }) => document.plugins.map(pluginEntryTarget)), identities, ids)
    // A string equal to a plugin ID or selector is an activation rule, never a source.
    if (ids.has(spec)) throw new PluginSourcesError("The spec names an existing plugin ID", "invalid", "plugin-id")
    await this.options.documents.editConfigDocument(workspaceId, request.location, scope, document => {
      // A turn abandoned at its deadline never writes after the next add has started.
      if (signal.aborted) throw new PluginSourcesError("OpenCode did not answer in time", "unavailable", "timeout")
      assertNotDeclared(document.plugins.map(pluginEntryTarget), identities, ids)
      return appendPluginControlRule(document, spec)
    })
    this.options.logger.info({ workspaceId, scope }, "Added OpenCode plugin source")
    return { scope, spec, reloadPending: true }
  }

  async remove(workspaceId: string, request: PluginSourceRemoveRequest): Promise<PluginSourceMutationResponse> {
    const { scope, target, entryIndex } = request
    await this.options.documents.editConfigDocument(workspaceId, request.location, scope, document => {
      try {
        return removePluginSourceEntry(document, entryIndex, target)
      } catch (error) {
        if (error instanceof PluginControlDocumentError && error.kind === "conflict") {
          throw new PluginSourcesError(error.message, "conflict", "stale")
        }
        throw error
      }
    })
    this.options.logger.info({ workspaceId, scope }, "Removed OpenCode plugin source")
    return { scope, spec: target, reloadPending: true }
  }
}

function knownPluginIds(snapshot: PluginControlsSnapshot): Set<string> {
  return new Set([
    ...snapshot.controls.map(control => control.id),
    ...snapshot.runtime.flatMap(entry => entry.id ? [entry.id] : []),
    ...snapshot.configured.rules.map(rule => rule.selector),
  ])
}

function assertNotDeclared(targets: readonly string[], identities: ReadonlySet<string>, ids: ReadonlySet<string>): void {
  for (const target of targets) {
    // Rules (`-id`, `id`, wildcards) are not sources and never collide with a package.
    if (target.startsWith("-") || target.includes("*") || ids.has(target)) continue
    if (pluginPackageIdentities(target).some(identity => identities.has(identity))) {
      throw new PluginSourcesError("This plugin package is already declared", "conflict", "duplicate")
    }
  }
}
