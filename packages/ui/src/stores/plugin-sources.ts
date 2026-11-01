import { createSignal } from "solid-js"
import type {
  PluginConfiguredSource,
  PluginControlLocation,
  PluginControlScope,
  PluginControlsSnapshot,
} from "../../../server/src/api-types"
import type { PluginSourceAddRequest, PluginSourceMutationResponse, PluginSourceRemoveRequest } from "../../../server/src/plugin-source-types"
import { serverApi } from "../lib/api-client"
import { pluginControlsCache } from "./plugin-controls"

/** How long an added source may stay absent from `plugin.list` before it is shown as not confirmed. */
export const PLUGIN_SOURCE_PENDING_TIMEOUT_MS = 120_000
const MAX_TRACKED = 100

/** `pending`: added here and not yet in the inventory; `unconfirmed`: configured, but still absent
 * after the pending window (disabled, or never installed). Loaded sources use the runtime state. */
export type PluginSourceState = "pending" | "unconfirmed"

interface Tracked {
  key: string; spec: string; scope: PluginControlScope; startedAt: number
  submitted: boolean; observed: boolean; document?: string; owner?: object; integration?: string; trackingTarget?: string; runtimeID?: string; context?: string | null
}

interface Api {
  addPluginSource(instanceId: string, payload: PluginSourceAddRequest): Promise<PluginSourceMutationResponse>
  removePluginSource(instanceId: string, payload: PluginSourceRemoveRequest): Promise<PluginSourceMutationResponse>
}

const locationKey = (instanceId: string, location: PluginControlLocation) => JSON.stringify([instanceId, location.directory])

export class PluginSourcesStore {
  private readonly added = createSignal<readonly Tracked[]>([])
  private readonly removing = createSignal<ReadonlySet<string>>(new Set())
  // Bumped when a pending window closes, so derived rows change state without other events.
  private readonly tick = createSignal(0)
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly api: Api,
    private readonly invalidate: (instanceId: string) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly schedule: (callback: () => void, delay: number) => unknown = (callback, delay) => setTimeout(callback, delay),
  ) {}

  private key(instanceId: string, location: PluginControlLocation): string {
    return locationKey(instanceId, pluginControlsCache.state(instanceId, location).snapshot?.location ?? location)
  }

  async add(instanceId: string, location: PluginControlLocation, scope: PluginControlScope, spec: string): Promise<void> {
    const target = pluginControlsCache.state(instanceId, location).snapshot?.targets.find(target => target.scope === scope)
    const attempt = this.begin(instanceId, location, scope, spec, { document: target?.path, context: target?.trackingContext ?? null })
    try {
      const response = await this.api.addPluginSource(instanceId, { location: { directory: location.directory }, scope, spec })
      if (response?.scope !== scope || response.spec !== spec || response.reloadPending !== true) throw new Error("Plugin source addition could not be confirmed")
      this.submitted(attempt)
    } catch (error) { this.consume(attempt); throw error }
    finally { this.invalidate(instanceId) }
  }

  /** Reserve BEFORE transmission. Receipts can update this exact handle, never recreate it. */
  begin(instanceId: string, location: PluginControlLocation, scope: PluginControlScope, spec: string,
    context: { document?: string; owner?: object; integration?: string; runtimeID?: string; context?: string | null } = {}): Tracked {
    const entry: Tracked = { key: this.key(instanceId, location), spec, scope, startedAt: this.now(),
      submitted: false, observed: false, ...context }
    this.added[1](previous => [...previous.filter(item => !(item.key === entry.key && item.spec === spec && item.scope === scope)), entry].slice(-MAX_TRACKED))
    this.schedule(() => {
      if (!this.added[0]().includes(entry)) return
      this.tick[1](value => value + 1)
      for (const notify of this.listeners) notify()
    }, PLUGIN_SOURCE_PENDING_TIMEOUT_MS + 1)
    return entry
  }

  submitted(attempt: Tracked): void {
    if (!this.added[0]().includes(attempt) || attempt.submitted) return
    attempt.submitted = true
    this.tick[1](value => value + 1)
    for (const notify of this.listeners) notify()
  }

  consume(attempt: Tracked): void { this.added[1](previous => previous.filter(item => item !== attempt)) }
  clearOwner(owner: object): void { this.added[1](previous => previous.filter(item => item.owner !== owner)) }
  onChanged(notify: () => void): () => void { this.listeners.add(notify); return () => this.listeners.delete(notify) }

  /** Authoritative observations consume hints one-way, including when runtime later vanishes. */
  observe(attempt: Tracked, declared: boolean, runtime: boolean): void {
    if (!this.added[0]().includes(attempt)) return
    if (runtime || attempt.observed && !declared) { this.consume(attempt); return }
    if (declared && !attempt.observed) { attempt.observed = true; this.tick[1](value => value + 1) }
  }

  observeSnapshot(instanceId: string, snapshot: PluginControlsSnapshot): void {
    for (const attempt of this.addedSpecs(instanceId, snapshot.location)) {
      if (!attempt.integration && attempt.context !== undefined && (attempt.context === null
        || snapshot.targets.find(target => target.scope === attempt.scope)?.trackingContext !== attempt.context)) { this.consume(attempt); continue }
      const sources = snapshot.configured.sources.filter(source => (attempt.integration ? source.trackingTarget === attempt.spec : source.target === attempt.spec)
        && source.scope === attempt.scope
        && (attempt.document === undefined || source.path === attempt.document))
      if (sources.length === 1 && sources[0]!.trackingTarget !== undefined) {
        if (attempt.trackingTarget !== undefined && attempt.trackingTarget !== sources[0]!.trackingTarget) { this.consume(attempt); continue }
        attempt.trackingTarget = sources[0]!.trackingTarget
      }
      this.observe(attempt, sources.length === 1, snapshot.runtime.some(entry => {
        const target = entry.source.type === "package" ? entry.source.target : undefined
        return target !== undefined && (sources.some(source => source.target === target) || !attempt.integration && target === attempt.spec)
          || entry.id !== undefined && (entry.id === attempt.runtimeID || sources.some(source => source.pluginId === entry.id))
      }))
    }
  }

  async remove(instanceId: string, location: PluginControlLocation, source: PluginConfiguredSource & { scope: PluginControlScope }): Promise<void> {
    if (!source.expectedRevision) throw new Error("Plugin source confirmation is unavailable")
    const identity = removalKey(instanceId, location, source)
    if (this.removing[0]().has(identity)) return
    this.removing[1](previous => new Set(previous).add(identity))
    try {
      const response = await this.api.removePluginSource(instanceId, {
        location: { directory: location.directory }, scope: source.scope, target: source.target, entryIndex: source.entryIndex,
        expectedRevision: source.expectedRevision,
      })
      if (response?.scope !== source.scope || response.spec !== source.target || response.reloadPending !== true) throw new Error("Plugin source removal could not be confirmed")
    } finally {
      // An explicit removal supersedes this view's Installing hint even when its response is
      // lost. The reconciled configured/runtime inventory determines whether a row still exists.
      const matching = this.addedSpecs(instanceId, location)
      this.added[1](previous => previous.filter(item => !(matching.includes(item) && item.scope === source.scope
        && (item.spec === source.target || item.spec === source.trackingTarget))))
      this.removing[1](previous => { const next = new Set(previous); next.delete(identity); return next })
      this.invalidate(instanceId)
    }
  }

  isRemoving(instanceId: string, location: PluginControlLocation, source: PluginConfiguredSource): boolean {
    return this.removing[0]().has(removalKey(instanceId, location, source))
  }

  /** Specs added from this location that are still waiting for the inventory, newest last. */
  addedSpecs(instanceId: string, location: PluginControlLocation): readonly Tracked[] {
    const key = this.key(instanceId, location)
    return this.added[0]().filter(item => {
      const [instance, directory] = JSON.parse(item.key) as [string, string]
      return instance === instanceId && this.key(instance, { directory }) === key
    })
  }

  /** State of a configured or just-added source with no runtime entry yet. */
  state(instanceId: string, location: PluginControlLocation, target: string, scope?: PluginControlScope, trackingTarget?: string): PluginSourceState {
    this.tick[0]()
    const tracked = this.addedSpecs(instanceId, location).find(item => (item.spec === target || item.trackingTarget === target
      || trackingTarget !== undefined && item.spec === trackingTarget) && (scope === undefined || item.scope === scope))
    return tracked?.submitted && tracked.observed && this.now() - tracked.startedAt <= PLUGIN_SOURCE_PENDING_TIMEOUT_MS ? "pending" : "unconfirmed"
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

export const pluginSourcesStore = new PluginSourcesStore(serverApi, instanceId => pluginControlsCache.invalidateInstance(instanceId))
