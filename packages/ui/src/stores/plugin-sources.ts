import { createSignal } from "solid-js"
import type {
  PluginConfiguredSource,
  PluginControlLocation,
  PluginControlScope,
  PluginControlsSnapshot,
} from "../../../server/src/api-types"
import type { IntegrationView } from "../../../server/src/integration-types"
import type { PluginSourceAddRequest, PluginSourceMutationResponse, PluginSourceRemoveRequest } from "../../../server/src/plugin-source-types"
import { serverApi } from "../lib/api-client"
import { installIntegration } from "../lib/integrations-api"
import { integrations } from "./integrations"
import { pluginControlsCache } from "./plugin-controls"
import { captureBackendOperation } from "../lib/backend-operation"

/** How long an added source may stay absent from `plugin.list` before it is shown as not confirmed. */
export const PLUGIN_SOURCE_PENDING_TIMEOUT_MS = 120_000
const MAX_TRACKED = 100

/** `pending`: added here and not yet in the inventory; `unconfirmed`: configured, but still absent
 * after the pending window (disabled, or never installed). Loaded sources use the runtime state. */
export type PluginSourceState = "pending" | "unconfirmed"

/** `active`/`failed`: the inventory loaded the integration's plugin, or failed to; otherwise its install hint. */
export type IntegrationInstallState = PluginSourceState | "active" | "failed"

/** One add, reserved before transmission; `spec` is known and the hint shown only once the server confirmed the write. */
interface Tracked { key: string; scope: PluginControlScope; startedAt: number; submitted: boolean; spec?: string; integration?: string; signal?: AbortSignal }
type Submitted = Tracked & { spec: string; submitted: true }

interface Api {
  addPluginSource(instanceId: string, payload: PluginSourceAddRequest): Promise<PluginSourceMutationResponse>
  removePluginSource(instanceId: string, payload: PluginSourceRemoveRequest): Promise<PluginSourceMutationResponse>
  installIntegration(instanceId: string, directory: string, integrationId: string, scope: PluginControlScope): Promise<PluginSourceMutationResponse>
}

const locationKey = (instanceId: string, location: PluginControlLocation) => JSON.stringify([instanceId, location.directory])

export class PluginSourcesStore {
  private readonly added = createSignal<readonly Tracked[]>([])
  private readonly removing = createSignal<ReadonlySet<string>>(new Set())
  // Bumped when a pending window closes, so derived rows change state without other events.
  private readonly tick = createSignal(0)

  constructor(
    private readonly api: Api,
    private readonly invalidate: (instanceId: string) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly schedule: (callback: () => void, delay: number) => unknown = (callback, delay) => setTimeout(callback, delay),
    private readonly refreshIntegrations: (instanceId: string) => void = () => {},
    private readonly signalForInstance?: (id: string) => AbortSignal,
  ) {}

  async add(instanceId: string, location: PluginControlLocation, scope: PluginControlScope, spec: string): Promise<void> {
    const attempt = this.begin(instanceId, location, scope)
    try {
      attempt.signal?.throwIfAborted()
      await this.api.addPluginSource(instanceId, { location: { directory: location.directory }, scope, spec })
      this.submitted(attempt, spec)
    } catch (error) { this.consume(attempt); throw error }
    // The response is only the durable configured state; the inventory decides what loaded.
    finally { if (!attempt.signal?.aborted) this.invalidate(instanceId) }
  }

  /**
   * Installs a catalog integration by ID. The pending hint follows the spec the server returned; a lost or refused
   * answer leaves no hint and is never replayed: the refreshed inventory shows what was written.
   */
  async installIntegration(instanceId: string, location: PluginControlLocation, integrationId: string, scope: PluginControlScope): Promise<PluginSourceMutationResponse> {
    const attempt = this.begin(instanceId, location, scope, integrationId)
    try {
      attempt.signal?.throwIfAborted()
      const response = await this.api.installIntegration(instanceId, location.directory, integrationId, scope)
      this.submitted(attempt, response?.scope === scope && response.reloadPending === true && typeof response.spec === "string" ? response.spec : undefined)
      return response
    } catch (error) { this.consume(attempt); throw error }
    finally {
      if (!attempt.signal?.aborted) { this.invalidate(instanceId); this.refreshIntegrations(instanceId) }
    }
  }

  /** Reserves an add before its transmission; only `submitted` makes it visible. */
  private begin(instanceId: string, location: PluginControlLocation, scope: PluginControlScope, integration?: string): Tracked {
    const signal = this.signalForInstance?.(instanceId)
    signal?.throwIfAborted()
    const entry: Tracked = { key: locationKey(instanceId, location), scope, startedAt: this.now(), submitted: false, signal, ...(integration ? { integration } : {}) }
    this.added[1](previous => [...previous, entry].slice(-MAX_TRACKED))
    return entry
  }

  /** Records the confirmed spec of a reserved add; an unconfirmed answer consumes it instead. */
  private submitted(attempt: Tracked, spec: string | undefined): void {
    if (attempt.signal?.aborted) { this.consume(attempt); return }
    if (!this.added[0]().includes(attempt) || attempt.submitted) return
    if (spec === undefined) { this.consume(attempt); throw new Error("Plugin source addition could not be confirmed") }
    const entry: Submitted = { ...attempt, spec, submitted: true, startedAt: this.now() }
    // A newer add of the same spec in the same scope supersedes the older hint.
    this.added[1](previous => [...previous.filter(item => item !== attempt
      && !(item.submitted && item.key === entry.key && item.spec === spec && item.scope === entry.scope)), entry].slice(-MAX_TRACKED))
    if (entry.signal?.aborted) return
    const cancel = () => clearTimeout(timer as ReturnType<typeof setTimeout>)
    const timer = this.schedule(() => {
      entry.signal?.removeEventListener("abort", cancel)
      if (!entry.signal?.aborted && this.added[0]().includes(entry)) this.tick[1](value => value + 1)
    }, PLUGIN_SOURCE_PENDING_TIMEOUT_MS + 1)
    entry.signal?.addEventListener("abort", cancel, { once: true })
  }

  private consume(attempt: Tracked): void {
    this.added[1](previous => previous.filter(item => item !== attempt))
  }

  async remove(instanceId: string, location: PluginControlLocation, source: PluginConfiguredSource & { scope: PluginControlScope }): Promise<void> {
    const signal = this.signalForInstance?.(instanceId)
    signal?.throwIfAborted()
    if (!source.expectedRevision) throw new Error("Plugin source confirmation is unavailable")
    const identity = removalKey(instanceId, location, source)
    if (this.removing[0]().has(identity)) return
    this.removing[1](previous => new Set(previous).add(identity))
    try {
      signal?.throwIfAborted()
      const response = await this.api.removePluginSource(instanceId, {
        location: { directory: location.directory }, scope: source.scope, target: source.target, entryIndex: source.entryIndex,
        expectedRevision: source.expectedRevision,
      })
      if (response?.scope !== source.scope || response.spec !== source.target || response.reloadPending !== true) throw new Error("Plugin source removal could not be confirmed")
    } finally {
      // An explicit removal supersedes this view's Installing hint even when its response is
      // lost. The reconciled configured/runtime inventory determines whether a row still exists.
      const key = locationKey(instanceId, location)
      if (!signal?.aborted) this.added[1](previous => previous.filter(item => !(item.submitted && item.key === key && item.spec === source.target && item.scope === source.scope)))
      this.removing[1](previous => { const next = new Set(previous); next.delete(identity); return next })
      if (!signal?.aborted) this.invalidate(instanceId)
    }
  }

  isRemoving(instanceId: string, location: PluginControlLocation, source: PluginConfiguredSource): boolean {
    return this.removing[0]().has(removalKey(instanceId, location, source))
  }

  /** Specs added from this location that are still waiting for the inventory, newest last. */
  addedSpecs(instanceId: string, location: PluginControlLocation): readonly Submitted[] {
    const key = locationKey(instanceId, location)
    return this.added[0]().filter((item): item is Submitted => !item.signal?.aborted && item.key === key && item.submitted)
  }

  /** State of a configured or just-added source with no runtime entry yet. */
  state(instanceId: string, location: PluginControlLocation, target: string): PluginSourceState {
    this.tick[0]()
    const tracked = this.addedSpecs(instanceId, location).find(item => item.spec === target)
    return tracked && this.now() - tracked.startedAt <= PLUGIN_SOURCE_PENDING_TIMEOUT_MS ? "pending" : "unconfirmed"
  }

  /**
   * Installation progress of a catalog integration from the integrations read: the inventory's loading facts
   * decide `active`/`failed`; otherwise an install sent from this location stays `pending` for the window, then
   * `unconfirmed`. `undefined` when it is neither declared, loaded nor being installed here.
   */
  installation(instanceId: string, location: PluginControlLocation, integration: Pick<IntegrationView, "id" | "plugin">): IntegrationInstallState | undefined {
    if (integration.plugin.runtime === "loaded") return "active"
    if (integration.plugin.runtime === "failed") return "failed"
    const installs = this.addedSpecs(instanceId, location).filter(item => item.integration === integration.id)
    const tracked = installs[installs.length - 1]
    if (tracked) return this.state(instanceId, location, tracked.spec)
    return integration.plugin.declared ? "unconfirmed" : undefined
  }

  clearInstance(instanceId: string): void {
    const prefix = JSON.stringify([instanceId]).slice(0, -1)
    this.added[1](previous => previous.filter(item => !item.key.startsWith(`${prefix},`)))
  }
}

function removalKey(instanceId: string, location: PluginControlLocation, source: PluginConfiguredSource): string {
  return JSON.stringify([instanceId, location.directory, source.scope, source.target, source.entryIndex])
}

/** Declarations the shared document primitive can remove: those in the scope's own write target. */
export function removableSources(snapshot: PluginControlsSnapshot | undefined, matches: (source: PluginConfiguredSource) => boolean) {
  if (!snapshot) return []
  return snapshot.configured.sources.filter((source): source is PluginConfiguredSource & { scope: PluginControlScope } => (
    (source.scope === "global" || source.scope === "project") && matches(source)
    && snapshot.targets.some(target => target.scope === source.scope && Boolean(source.path) && samePath(target.path, source.path!))
  )).map(source => ({ ...source, expectedRevision: snapshot.targets.find(target => target.scope === source.scope)?.expectedRevision }))
}

function samePath(left: string, right: string): boolean {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(left)
  const normalize = (value: string) => (windows ? value.replace(/\\/g, "/").toLowerCase() : value).replace(/\/+$/, "")
  return normalize(left) === normalize(right)
}

export const pluginSourcesStore = new PluginSourcesStore({
  addPluginSource: (instanceId, payload) => serverApi.addPluginSource(instanceId, payload),
  removePluginSource: (instanceId, payload) => serverApi.removePluginSource(instanceId, payload),
  installIntegration: (instanceId, directory, integrationId, scope) => installIntegration(instanceId, directory, integrationId, scope),
}, instanceId => pluginControlsCache.invalidateInstance(instanceId), undefined, undefined,
instanceId => { void integrations.refreshDemanded(instanceId) }, id => captureBackendOperation(id).signal)
