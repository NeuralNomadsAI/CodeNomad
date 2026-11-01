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
import type { IntegrationCatalogSource } from "./integrations/catalog"
import { integrationsForSpec } from "./integrations/recognition"

export class PluginSourcesError extends PluginControlsError {
  constructor(message: string, kind: PluginControlsErrorKind, readonly code: PluginSourceErrorCode) {
    super(message, kind)
    this.name = "PluginSourcesError"
  }
}

type Documents = Pick<PluginControls, "read" | "readConfigDocuments" | "editConfigDocument">
type Catalog = Pick<IntegrationCatalogSource, "read">

/** Bound on one queued add (its daemon reads and the write) before it is refused as unavailable. */
export const PLUGIN_SOURCE_ADD_TIMEOUT_MS = 20_000
const PLUGIN_SOURCE_ABORT_GRACE_MS = 5_000

/**
 * Source declarations (add/remove) on top of the shared fenced configuration-document
 * primitive: scope resolution, ownership, the deletion fence, connection fencing, JSONC
 * preservation, locks, atomic replacement and WSL all come from `editConfigDocument`.
 * The package cache is never touched; OpenCode reloads the watched document.
 */
export class PluginSources {
  // One queue for the whole server: the Global document is shared by every workspace.
  private addTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: { documents: Documents; logger: Logger; catalog?: Catalog; addTimeoutMs?: number; abortGraceMs?: number }) {}

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

  // The deadline aborts the turn; the turn's own outcome is reported, so a timeout is reported
  // only when nothing was written (reads abort, the commit re-checks the signal under the lock).
  // A client that ignores the signal still releases the queue after a short grace period; the
  // abandoned turn then fails its next signal check before any write.
  private withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const timeout = () => new PluginSourcesError("OpenCode did not answer in time", "unavailable", "timeout")
    return new Promise<T>((resolve, reject) => {
      let grace: ReturnType<typeof setTimeout> | undefined
      const timer = setTimeout(() => {
        controller.abort()
        grace = setTimeout(() => reject(timeout()), this.options.abortGraceMs ?? PLUGIN_SOURCE_ABORT_GRACE_MS)
      }, this.options.addTimeoutMs ?? PLUGIN_SOURCE_ADD_TIMEOUT_MS)
      operation(controller.signal)
        .then(resolve, error => reject(controller.signal.aborted ? timeout() : error))
        .finally(() => { clearTimeout(timer); clearTimeout(grace) })
    })
  }

  private async addSerialized(workspaceId: string, request: PluginSourceAddRequest, signal: AbortSignal): Promise<PluginSourceMutationResponse> {
    const { spec, scope } = request
    const [snapshot, raw, catalog] = await Promise.all([
      this.options.documents.read(workspaceId, request.location, signal),
      this.options.documents.readConfigDocuments(workspaceId, request.location, signal),
      this.options.catalog?.read().then(view => view.catalog),
    ])
    signal.throwIfAborted()
    // A recognised integration (spec change §4.2) is one package whatever its spec: registry and Git
    // specs of the same integration, or a spec of an integration whose plugin already loaded, collide.
    const integrations = catalog ? integrationsForSpec(catalog, spec) : []
    if (scope === "project" && integrations.some(entry => entry.family === "native")) {
      throw new PluginSourcesError("This integration installs in Global configuration only", "invalid", "global-only")
    }
    const identities = new Set([...pluginPackageIdentities(spec), ...integrations.map(entry => `integration:${entry.id}`)])
    const identify = (target: string) => [...pluginPackageIdentities(target),
      ...(catalog ? integrationsForSpec(catalog, target).map(entry => `integration:${entry.id}`) : [])]
    const loaded = new Set(snapshot.runtime.flatMap(entry => entry.id ? [entry.id] : []))
    if (integrations.some(entry => loaded.has(entry.plugin))) {
      throw new PluginSourcesError("This plugin package is already declared", "conflict", "duplicate")
    }
    const ids = knownPluginIds(snapshot)
    // The daemon's documents cover every effective scope (Global, Project, inherited and
    // inline); the raw target documents also cover writes the daemon has not reloaded yet.
    assertNotDeclared(snapshot.configured.sources.map(source => source.target), identities, new Set(), identify)
    assertNotDeclared(raw.documents.flatMap(({ document }) => document.plugins.map(pluginEntryTarget)), identities, ids, identify)
    // A string equal to a plugin ID or selector is an activation rule, never a source.
    if (ids.has(spec)) throw new PluginSourcesError("The spec names an existing plugin ID", "invalid", "plugin-id")
    await this.options.documents.editConfigDocument(workspaceId, request.location, scope, document => {
      signal.throwIfAborted()
      assertNotDeclared(document.plugins.map(pluginEntryTarget), identities, ids, identify)
      return appendPluginControlRule(document, spec)
    }, signal)
    this.options.logger.info({ workspaceId, scope }, "Added OpenCode plugin source")
    return { scope, spec, reloadPending: true }
  }

  async remove(workspaceId: string, request: PluginSourceRemoveRequest): Promise<PluginSourceMutationResponse> {
    const { scope, target, entryIndex } = request
    if (!/^[a-f0-9]{64}$/.test(request.expectedRevision ?? "")) {
      throw new PluginSourcesError("OpenCode configuration confirmation is unavailable", "conflict", "stale")
    }
    try {
      await this.options.documents.editConfigDocument(workspaceId, request.location, scope, document => {
      try {
        return removePluginSourceEntry(document, entryIndex, target)
      } catch (error) {
        if (error instanceof PluginControlDocumentError && error.kind === "conflict") {
          throw new PluginSourcesError(error.message, "conflict", "stale")
        }
        throw error
      }
      }, undefined, request.expectedRevision)
    } catch (error) {
      if (error instanceof PluginControlsError && error.kind === "conflict") throw new PluginSourcesError("OpenCode configuration changed since confirmation", "conflict", "stale")
      throw error
    }
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

function assertNotDeclared(targets: readonly string[], identities: ReadonlySet<string>, ids: ReadonlySet<string>,
  identify: (target: string) => string[]): void {
  for (const target of targets) {
    // Rules (`-id`, `id`, wildcards) are not sources and never collide with a package.
    if (target.startsWith("-") || target.includes("*") || ids.has(target)) continue
    if (identify(target).some(identity => identities.has(identity))) {
      throw new PluginSourcesError("This plugin package is already declared", "conflict", "duplicate")
    }
  }
}
