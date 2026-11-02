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

interface Tracked { key: string; spec: string; scope: PluginControlScope; startedAt: number }

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

  constructor(
    private readonly api: Api,
    private readonly invalidate: (instanceId: string) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly schedule: (callback: () => void, delay: number) => unknown = (callback, delay) => setTimeout(callback, delay),
  ) {}

  async add(instanceId: string, location: PluginControlLocation, scope: PluginControlScope, spec: string): Promise<void> {
    await this.api.addPluginSource(instanceId, { location: { directory: location.directory }, scope, spec })
    const key = locationKey(instanceId, location)
    const entry = { key, spec, scope, startedAt: this.now() }
    this.added[1](previous => [...previous.filter(item => !(item.key === key && item.spec === spec)), entry].slice(-MAX_TRACKED))
    this.schedule(() => this.tick[1](value => value + 1), PLUGIN_SOURCE_PENDING_TIMEOUT_MS + 1)
    // The response is only the durable configured state; the inventory decides what loaded.
    this.invalidate(instanceId)
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
      const key = locationKey(instanceId, location)
      this.added[1](previous => previous.filter(item => !(item.key === key && item.spec === source.target && item.scope === source.scope)))
      this.removing[1](previous => { const next = new Set(previous); next.delete(identity); return next })
      this.invalidate(instanceId)
    }
  }

  isRemoving(instanceId: string, location: PluginControlLocation, source: PluginConfiguredSource): boolean {
    return this.removing[0]().has(removalKey(instanceId, location, source))
  }

  /** Specs added from this location that are still waiting for the inventory, newest last. */
  addedSpecs(instanceId: string, location: PluginControlLocation): readonly Tracked[] {
    const key = locationKey(instanceId, location)
    return this.added[0]().filter(item => item.key === key)
  }

  /** State of a configured or just-added source with no runtime entry yet. */
  state(instanceId: string, location: PluginControlLocation, target: string): PluginSourceState {
    this.tick[0]()
    const tracked = this.addedSpecs(instanceId, location).find(item => item.spec === target)
    return tracked && this.now() - tracked.startedAt <= PLUGIN_SOURCE_PENDING_TIMEOUT_MS ? "pending" : "unconfirmed"
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
