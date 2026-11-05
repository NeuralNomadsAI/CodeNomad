import { For, Show, createEffect, createMemo, createUniqueId, onCleanup, type Component } from "solid-js"
import { Tooltip } from "@kobalte/core/tooltip"
import { Loader2, RefreshCw } from "lucide-solid"
import type {
  PluginConfiguredSource,
  PluginControlLocation,
  PluginControlScope,
  PluginRuntimeInventoryEntry,
  PluginRuntimeSource,
} from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { integrationPlugin } from "../lib/integration-rows"
import { integrations } from "../stores/integrations"
import { pluginControlsCache } from "../stores/plugin-controls"
import { pluginSourcesStore, removableSources } from "../stores/plugin-sources"
import { PluginActivationSwitch } from "./plugin-activation-switch"
import { PluginRowActions } from "./plugin-row-actions"
import { PluginAddMenu } from "./plugin-add-menu"
import "../stores/plugin-controls-events"
import { getProjectAvailability } from "../stores/project-capability"

interface PluginActivationControlsProps {
  instanceId: string
  location: PluginControlLocation
  active?: boolean
  session?: { id: string; title?: string; metadata?: Record<string, unknown> }
}

export const PluginActivationControls: Component<PluginActivationControlsProps> = (props) => {
  const { t } = useI18n()
  let disposed = false
  onCleanup(() => { disposed = true })
  const admitted = () => !disposed && getProjectAvailability(props.instanceId, "plugins").allowed
  // prototype-1236: an explicit server lists its plugins; no OpenCode API writes their configuration.
  const writable = () => getProjectAvailability(props.instanceId, "pluginWrite").allowed
  const headingId = `plugin-controls-${createUniqueId()}`
  const noticeId = `${headingId}-notice`
  const globalLabelId = `plugin-controls-${createUniqueId()}-global`
  const projectLabelId = `plugin-controls-${createUniqueId()}-project`
  const directory = createMemo(() => props.location.directory)
  createEffect(() => {
    const instanceId = props.instanceId, location = directory()
    if (props.active === false || !location || !admitted()) return
    onCleanup(integrations.demand(instanceId, location))
  })
  // A source that designates an ambiguous integration belongs to none: its row says so.
  const nonConforming = (sources: readonly Pick<PluginConfiguredSource, "scope" | "entryIndex">[]) => {
    const value = integrations.state(props.instanceId, directory())
    return value.status === "ready" && sourcesOverlap(value.response.ambiguousSources ?? [], sources)
  }
  const nonConformingLabel = (sources: readonly Pick<PluginConfiguredSource, "scope" | "entryIndex">[]) => (
    <Show when={nonConforming(sources)}>
      <span class="integration-state-badge badge-shape" data-integration-state="nonConforming">{t("integrations.state.nonConforming")}</span>
    </Show>
  )
  let cachedLocation: PluginControlLocation | undefined
  const requestLocation = (): PluginControlLocation => {
    if (!cachedLocation || cachedLocation.directory !== directory()) {
      cachedLocation = { directory: directory() }
    }
    return cachedLocation
  }
  const state = createMemo(() => pluginControlsCache.state(props.instanceId, requestLocation()))
  const consentEpoch = () => state().invalidationRevision
  const snapshot = createMemo(() => state().snapshot)
  const nativeControls = createMemo(() => {
    const value = integrations.state(props.instanceId, directory())
    return new Set(value.status === "ready" ? value.response.integrations
      .filter(entry => entry.family === "native" && !entry.ambiguous)
      .map(entry => integrationPlugin(snapshot(), entry).control?.id).filter(Boolean) : [])
  })
  const controls = createMemo(() => (
    snapshot()?.controls.filter((control) => !control.builtin && control.runtime?.source.type !== "builtin") ?? []
  ))
  const controlsById = createMemo(() => new Map(controls().map((control) => [control.id, control])))
  const controlIds = createMemo(() => [...controlsById().keys()])
  // A package can fail before exporting a plugin ID. Keep its native target
  // actionable without inventing an ID that could become an activation rule.
  const packagesByTarget = createMemo(() => {
    const represented = new Set(controls().flatMap(control =>
      control.runtime?.source.type === "package" ? [control.runtime.source.target] : []))
    const packages = new Map<string, PluginRuntimeInventoryEntry>()
    for (const entry of snapshot()?.runtime ?? []) {
      if (entry.source.type !== "package" || represented.has(entry.source.target)) continue
      if (!packages.has(entry.source.target)) packages.set(entry.source.target, entry)
    }
    return packages
  })
  const packageTargets = createMemo(() => [...packagesByTarget().keys()])
  // Declarations and just-added specs the inventory does not report yet: installing,
  // disabled, or never confirmed. Their rows carry no switch (no plugin ID is known).
  const sourceTargets = createMemo(() => {
    const loaded = new Set((snapshot()?.runtime ?? []).flatMap(entry => entry.source.type === "package" ? [entry.source.target] : []))
    const targets = new Set<string>()
    const configured = new Set<string>()
    for (const source of snapshot()?.configured.sources ?? []) {
      configured.add(source.target)
      if (!source.pluginId && !loaded.has(source.target)) targets.add(source.target)
    }
    // An added spec removed elsewhere stops being shown once its pending window closes.
    for (const added of pluginSourcesStore.addedSpecs(props.instanceId, requestLocation())) {
      if (loaded.has(added.spec)) continue
      if (configured.has(added.spec) || pluginSourcesStore.state(props.instanceId, requestLocation(), added.spec) === "pending") targets.add(added.spec)
    }
    return [...targets]
  })
  const projectAvailable = () => snapshot()?.targets.some((target) => target.scope === "project") === true
  createEffect(() => {
    const instanceId = props.instanceId
    const location = requestLocation()
    if (props.active === false || !admitted()) return
    onCleanup(pluginControlsCache.acquireDemand(instanceId, location))
  })
  const bidi = (text: string): string => `⁨${text}⁩`

  const sourceLabel = (source: PluginRuntimeSource): string => {
    if (source.type === "package") return t("instanceServiceStatus.plugins.source.package", { source: source.target })
    if (source.type === "local") return t("instanceServiceStatus.plugins.source.local", { source: source.path })
    if (source.type === "builtin") return t("instanceServiceStatus.plugins.source.builtin")
    return t("instanceServiceStatus.plugins.source.sdk")
  }

  // Version, update availability, failure and its native log reference, for any plugin row.
  const runtimeLines = (entry: PluginRuntimeInventoryEntry | undefined): string[] => {
    if (!entry) return []
    const lines = [sourceLabel(entry.source)]
    if (entry.source.type === "package" && entry.source.version) {
      lines.push(t("instanceServiceStatus.plugins.sources.version", { version: entry.source.version }))
    }
    if (entry.source.type === "package" && entry.source.outdated) lines.push(t("instanceServiceStatus.plugins.sources.outdated"))
    if (entry.state.status === "failed") {
      lines.push(`${t("instanceServiceStatus.plugins.runtime.failed")} — ${entry.state.error}`)
      if (entry.state.ref) lines.push(t("instanceServiceStatus.plugins.sources.failureRef", { ref: entry.state.ref }))
    }
    return lines
  }

  // A desktop-app (GUI) package loads those parts only from Global configuration.
  const guiNotice = (entry: PluginRuntimeInventoryEntry | undefined, declaredIn: readonly { scope: string }[]): string[] => (
    entry?.features.gui && declaredIn.some(source => source.scope !== "global")
      ? [t("instanceServiceStatus.plugins.sources.guiGlobalOnly")] : []
  )

  const declarationsFor = (matches: (source: PluginConfiguredSource) => boolean) => (
    snapshot()?.configured.sources.filter(matches) ?? []
  )
  const refresh = () => {
    if (!admitted()) return
    void pluginControlsCache.load(props.instanceId, requestLocation(), { force: true })
    void integrations.refreshDemanded(props.instanceId)
  }

  const renderControl = (pluginId: string) => {
    // Key rows by ID, but read every displayed value from the current snapshot.
    // Passive refreshes must not replace the focused row's DOM.
    const control = createMemo(() => controlsById().get(pluginId))
    const failed = () => control()?.runtime?.state.status === "failed"
    const overridden = () => Boolean(control() && control()?.project !== "default")
    const isAvailable = (scope: PluginControlScope): boolean =>
      snapshot()?.targets.some((target) => target.scope === scope) === true
    const matchesControl = (source: PluginConfiguredSource) => {
      const runtime = control()?.runtime?.source
      return source.pluginId === pluginId || (runtime?.type === "package" && runtime.target === source.target)
    }
    const removable = createMemo(() => removableSources(snapshot(), matchesControl), [], {
      equals: (left, right) => left.length === right.length && left.every((source, index) => sameSource(source, right[index]!)),
    })
    const details = () => {
      const current = control()
      const lines = [pluginId, ...runtimeLines(current?.runtime), ...guiNotice(current?.runtime, declarationsFor(matchesControl))]
      if (!failed() && overridden()) lines.push(t("instanceServiceStatus.plugins.globalOverridden"))
      for (const target of snapshot()?.targets ?? []) {
        lines.push(`${scopeLabel(target.scope)} — ${target.path}`)
      }
      if (!isAvailable("project") && writable()) lines.push(t("instanceServiceStatus.plugins.scope.unavailable"))
      if (state().error) lines.push(t("instanceServiceStatus.plugins.errors.refresh"))
      return lines.map(bidi).join("\n")
    }
    const renderSwitch = (scope: PluginControlScope) => {
      const labelId = scope === "global" ? globalLabelId : projectLabelId
      return <PluginActivationSwitch instanceId={props.instanceId} location={requestLocation()} control={control()} scope={scope}
        lockedReason={scope === "project" && nativeControls().has(pluginId) ? t("integrations.section.scopeGlobalOnly") : undefined}
        available={isAvailable(scope)} active={props.active} describedBy={isAvailable(scope) ? labelId : `${labelId} ${noticeId}`}
        label={bidi(t("instanceServiceStatus.plugins.toggleAriaLabel", { name: `${pluginId} — ${scopeLabel(scope)}` }))} />
    }
    const nameId = `${headingId}-name-${pluginId}`
    return (
      <div class="plugin-control-row" data-plugin-id={pluginId} role="group" aria-labelledby={nameId}>
        <div class="plugin-control-identity"><Tooltip placement="top-start" openDelay={300}>
          <Tooltip.Trigger as="span" tabindex="0" id={nameId} class="plugin-control-name"><bdi>{pluginId}</bdi></Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="section-info-tooltip plugin-control-tooltip">{details()}</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip>{nonConformingLabel(declarationsFor(matchesControl))}<Show when={writable()}><PluginRowActions instanceId={props.instanceId} location={requestLocation()} name={pluginId}
          source={control()?.runtime?.source} removable={removable()} refresh={refresh} active={props.active} consentEpoch={consentEpoch()} sessionId={props.session?.id} /></Show></div>
        {renderSwitch("global")}
        {renderSwitch("project")}
      </div>
    )
  }

  const removableFor = (target: string) => createMemo(() => removableSources(snapshot(), source => source.target === target), [], {
    equals: (left, right) => left.length === right.length && left.every((source, index) => sameSource(source, right[index]!)),
  })

  const renderPackage = (target: string) => {
    const entry = () => packagesByTarget().get(target)
    const nameId = createUniqueId()
    const removable = removableFor(target)
    const details = () => {
      const current = entry()
      const lines = current ? runtimeLines(current) : [target]
      lines.push(...guiNotice(current, declarationsFor(source => source.target === target)))
      return lines.map(bidi).join("\n")
    }
    return <div class="plugin-control-row" data-package-target={target} role="group" aria-labelledby={nameId}>
      <div class="plugin-control-identity">
        <Tooltip placement="top-start" openDelay={300}>
          <Tooltip.Trigger as="span" tabindex="0" id={nameId} class="plugin-control-name"><bdi>{target}</bdi></Tooltip.Trigger>
          <Tooltip.Portal><Tooltip.Content class="section-info-tooltip plugin-control-tooltip">{details()}</Tooltip.Content></Tooltip.Portal>
        </Tooltip>
        {nonConformingLabel(declarationsFor(source => source.target === target))}
        <Show when={writable()}><PluginRowActions instanceId={props.instanceId} location={requestLocation()} name={target} source={entry()?.source}
          removable={removable()} refresh={refresh} active={props.active} consentEpoch={consentEpoch()} sessionId={props.session?.id} /></Show>
      </div>
    </div>
  }

  // Configured or just-added sources absent from the inventory. Pending rows stay busy until
  // `plugin.list` reports the target (it then becomes an ordinary row) or the window closes.
  const renderSource = (target: string) => {
    const nameId = createUniqueId()
    const removable = removableFor(target)
    const state = () => pluginSourcesStore.state(props.instanceId, requestLocation(), target)
    const details = () => [
      t("instanceServiceStatus.plugins.source.package", { source: target }),
      t(state() === "pending" ? "instanceServiceStatus.plugins.sources.pending" : "instanceServiceStatus.plugins.sources.unconfirmed"),
      ...declarationsFor(source => source.target === target).map(source => source.scope === "global" || source.scope === "project"
        ? `${scopeLabel(source.scope)} — ${source.path ?? ""}` : source.path ?? ""),
    ].map(bidi).join("\n")
    return <div class="plugin-control-row" data-source-target={target} data-source-state={state()} role="group" aria-labelledby={nameId}
      aria-busy={state() === "pending"}>
      <div class="plugin-control-identity">
        <Tooltip placement="top-start" openDelay={300}>
          <Tooltip.Trigger as="span" tabindex="0" id={nameId} class="plugin-control-name"><bdi>{target}</bdi></Tooltip.Trigger>
          <Tooltip.Portal><Tooltip.Content class="section-info-tooltip plugin-control-tooltip">{details()}</Tooltip.Content></Tooltip.Portal>
        </Tooltip>
        <Show when={state() === "pending"} fallback={<span class="plugin-source-state" role="status">{t("instanceServiceStatus.plugins.sources.unconfirmedLabel")}</span>}>
          <span class="plugin-source-state" role="status">
            <Loader2 class="h-3 w-3 animate-spin" aria-hidden="true" />{t("instanceServiceStatus.plugins.sources.pendingLabel")}
          </span>
        </Show>
        {nonConformingLabel(declarationsFor(source => source.target === target))}
        <Show when={writable()}><PluginRowActions instanceId={props.instanceId} location={requestLocation()} name={target} removable={removable()}
          refresh={state() === "unconfirmed" ? refresh : undefined} active={props.active} consentEpoch={consentEpoch()} sessionId={props.session?.id} /></Show>
      </div>
    </div>
  }

  return (
    <section
      class="plugin-controls"
      aria-label={t("instanceServiceStatus.sections.plugins")}
    >
      <Show when={snapshot() && !snapshot()?.targets.some((target) => target.scope === "project")}>
        <span id={noticeId} class="sr-only">{t("instanceServiceStatus.plugins.scope.unavailable")}</span>
      </Show>
      <div class="plugin-controls-header">
        <div class="plugin-controls-header-actions">
          <button
            type="button"
            class="icon-button-compact"
            data-plugin-refresh
            title={t("instanceServiceStatus.plugins.refresh")}
            aria-label={t("instanceServiceStatus.plugins.refresh")}
            aria-busy={state().loading || state().refreshing}
            disabled={state().loading || state().refreshing}
            onClick={refresh}
          >
            <RefreshCw class="h-3.5 w-3.5" classList={{ "animate-spin": state().loading || state().refreshing }} aria-hidden="true" />
          </button>
          <Show when={snapshot() && writable()}>
            <PluginAddMenu instanceId={props.instanceId} location={requestLocation()} sessionId={props.session?.id} projectAvailable={projectAvailable()} active={props.active} />
          </Show>
        </div>
        <span id={globalLabelId} class="plugin-control-scope-label">{scopeLabel("global")}</span>
        <span id={projectLabelId} class="plugin-control-scope-label">{scopeLabel("project")}</span>
      </div>

      <Show when={snapshot()} fallback={
        <div class="right-panel-empty-text" role="status">
          <p>{state().loading
            ? t("instanceServiceStatus.plugins.loading")
            : state().error
              ? t("instanceServiceStatus.plugins.errors.load")
              : t("instanceServiceStatus.plugins.loading")}</p>
        </div>
      }>
        <Show when={controlIds().length + packageTargets().length + sourceTargets().length > 0} fallback={<p class="right-panel-empty-text">{t("instanceServiceStatus.plugins.empty")}</p>}>
          <div class="plugin-control-list">
            <For each={controlIds()}>{renderControl}</For>
            <For each={packageTargets()}>{renderPackage}</For>
            <For each={sourceTargets()}>{renderSource}</For>
          </div>
        </Show>
      </Show>
    </section>
  )

  function scopeLabel(value: PluginControlScope): string {
    return t(`instanceServiceStatus.plugins.scope.${value}`)
  }

}

function sourcesOverlap(left: readonly Pick<PluginConfiguredSource, "scope" | "entryIndex">[], right: readonly Pick<PluginConfiguredSource, "scope" | "entryIndex">[]): boolean {
  return left.some(source => right.some(other => other.scope === source.scope && other.entryIndex === source.entryIndex))
}

export function sameSource(left: PluginConfiguredSource, right: PluginConfiguredSource): boolean {
  return left.scope === right.scope && left.target === right.target && left.entryIndex === right.entryIndex && left.path === right.path && left.expectedRevision === right.expectedRevision
}
