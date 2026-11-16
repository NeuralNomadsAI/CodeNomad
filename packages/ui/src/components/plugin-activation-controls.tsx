import { For, Show, createEffect, createMemo, createUniqueId, onCleanup, type Component, type JSX } from "solid-js"
import { Loader2, RefreshCw } from "lucide-solid"
import type {
  PluginConfiguredSource,
  PluginControlLocation,
  PluginControlScope,
  PluginRuntimeInventoryEntry,
  PluginRuntimeSource,
} from "../../../server/src/api-types"
import type { IntegrationView } from "../../../server/src/integration-types"
import { useI18n } from "../lib/i18n"
import { integrationConnection, integrationConnectionMessage, integrationStateLine } from "../lib/integration-row-state"
import { integrationDisplayPlugin } from "../lib/integration-rows"
import { integrationBindings, integrations } from "../stores/integrations"
import { pluginControlsCache } from "../stores/plugin-controls"
import { pluginSourcesStore, removableSources } from "../stores/plugin-sources"
import { createIntegrationHostInstallation } from "./integration-host-installation"
import { createIntegrationRowBinding } from "./integration-row-binding"
import { IntegrationStateLineView } from "./integration-state-line"
import { PluginActivationSwitch } from "./plugin-activation-switch"
import { PluginRowActions } from "./plugin-row-actions"
import { PluginAddMenu } from "./plugin-add-menu"
import { PluginSystemAttention } from "./plugin-system-attention"
import "../stores/plugin-controls-events"

interface PluginActivationControlsProps {
  instanceId: string
  location: PluginControlLocation
  active?: boolean
  session?: { id: string; title?: string; metadata?: Record<string, unknown> }
}

export const PluginActivationControls: Component<PluginActivationControlsProps> = (props) => {
  const { t } = useI18n()
  const headingId = `plugin-controls-${createUniqueId()}`
  const noticeId = `${headingId}-notice`
  const globalLabelId = `plugin-controls-${createUniqueId()}-global`
  const projectLabelId = `plugin-controls-${createUniqueId()}-project`
  const directory = createMemo(() => props.location.directory)
  createEffect(() => {
    const instanceId = props.instanceId, location = directory()
    if (props.active === false || !location) return
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
  let refreshButton: HTMLButtonElement | undefined
  // Recognised integrations by the plugin ID or the declared target of their row; an ambiguous one has no row of its own.
  const recognised = createMemo(() => {
    const value = integrations.state(props.instanceId, directory())
    const byControl = new Map<string, IntegrationView>(), byTarget = new Map<string, IntegrationView>()
    for (const entry of value.status === "ready" ? value.response.integrations : []) {
      if (entry.ambiguous) continue
      const plugin = integrationDisplayPlugin(snapshot(), entry)
      if (plugin.control) byControl.set(plugin.control.id, entry)
      for (const source of plugin.sources) byTarget.set(source.target, entry)
    }
    return { byControl, byTarget }
  })
  // Fresh reads only: installing an application part needs a current status.
  const freshIntegrations = () => {
    const value = integrations.state(props.instanceId, directory())
    return value.status === "ready" && !value.stale ? value.response.integrations : []
  }
  const installation = createIntegrationHostInstallation({
    get instanceId() { return props.instanceId },
    get directory() { return directory() },
    get sessionId() { return props.session?.id },
    get active() { return props.active },
    entries: freshIntegrations,
  })
  const controls = createMemo(() => (
    snapshot()?.controls.filter((control) => control.managedBy !== "codenomad" && !control.builtin && control.runtime?.source.type !== "builtin") ?? []
  ))
  const controlsById = createMemo(() => new Map(controls().map((control) => [control.id, control])))
  const controlIds = createMemo(() => [...controlsById().keys()])
  // A source can fail before exporting a plugin ID. Keep its native target
  // actionable without inventing an ID that could become an activation rule.
  const runtimesByTarget = createMemo(() => {
    const represented = new Set(controls().flatMap(control =>
      control.runtime?.source.type === "package" ? [control.runtime.source.target]
        : control.runtime?.source.type === "local" ? [control.runtime.source.path] : []))
    const entries = new Map<string, PluginRuntimeInventoryEntry>()
    for (const entry of snapshot()?.runtime ?? []) {
      if (entry.managedBy === "codenomad") continue
      const target = entry.source.type === "package" ? entry.source.target
        : entry.source.type === "local" && entry.state.status === "failed" ? entry.source.path : undefined
      if (!target || represented.has(target)) continue
      if (!entries.has(target)) entries.set(target, entry)
    }
    return entries
  })
  const runtimeTargets = createMemo(() => [...runtimesByTarget().keys()])
  // Declarations and just-added specs the inventory does not report yet: installing,
  // disabled, or never confirmed. Their rows carry no switch (no plugin ID is known).
  const sourceTargets = createMemo(() => {
    const loaded = new Set((snapshot()?.runtime ?? []).flatMap(entry => entry.source.type === "package" ? [entry.source.target]
      : entry.source.type === "local" ? [entry.source.path] : []))
    const targets = new Set<string>()
    const configured = new Set<string>()
    for (const source of snapshot()?.configured.sources ?? []) {
      configured.add(source.target)
      if (source.managedBy === "codenomad") continue
      if (!source.pluginId && !loaded.has(source.target)) targets.add(source.target)
    }
    // An added spec removed elsewhere stops being shown once its pending window closes.
    for (const added of pluginSourcesStore.addedSpecs(props.instanceId, requestLocation())) {
      if (snapshot()?.configured.sources.some(source => source.target === added.spec && source.managedBy === "codenomad")) continue
      if (loaded.has(added.spec)) continue
      if (configured.has(added.spec) || pluginSourcesStore.state(props.instanceId, requestLocation(), added.spec) === "pending") targets.add(added.spec)
    }
    return [...targets]
  })
  const projectAvailable = () => snapshot()?.targets.some((target) => target.scope === "project") === true
  createEffect(() => {
    const instanceId = props.instanceId
    const location = requestLocation()
    if (props.active === false) return
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
    if (props.active === false) return
    void pluginControlsCache.load(props.instanceId, requestLocation(), { force: true })
    void integrations.refreshDemanded(props.instanceId)
    if (props.session) void integrationBindings.refreshDemanded({
      instanceId: props.instanceId, directory: directory(), sessionID: props.session.id,
    })
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
    const integration = () => recognised().byControl.get(pluginId)
    const name = () => integration()?.displayName ?? pluginId
    const version = () => {
      const source = control()?.runtime?.source
      return integration()?.version ?? (source?.type === "package" ? source.version : undefined)
    }
    const binding = createIntegrationRowBinding({
      instanceId: () => props.instanceId, directory, sessionId: () => props.session?.id, integration, active: () => props.active !== false,
    })
    const line = createMemo(() => {
      const entry = integration()
      return entry ? integrationStateLine({ entry, link: binding.link(), offers: binding.offers(), conversation: Boolean(props.session),
        canInstall: Boolean(installation.action(entry.id)) }) : undefined
    }, undefined, { equals: (left, right) => JSON.stringify(left) === JSON.stringify(right) })
    const connection = () => {
      const entry = integration()
      if (!entry) return undefined
      const [key, vars] = integrationConnectionMessage(integrationConnection(entry), entry.app.name)
      return t(key, vars)
    }
    const hostAction = createMemo(() => {
      const entry = integration(), action = entry ? installation.action(entry.id) : undefined
      return entry && action ? { action, run: () => void installation.open(entry.id) } : undefined
    }, undefined, { equals: (left, right) => left?.action === right?.action })
    const details = () => {
      const current = control(), entry = integration()
      const lines = [t(`instanceServiceStatus.plugins.kind.${entry ? "integration" : "plugin"}`, { id: pluginId }),
        ...runtimeLines(current?.runtime), ...guiNotice(current?.runtime, declarationsFor(matchesControl))]
      const part = entry?.status?.host?.partVersion
      if (entry && part) lines.push(t("integrations.partVersion", { app: entry.app.name, version: part }))
      if (!failed() && overridden()) lines.push(t("instanceServiceStatus.plugins.globalOverridden"))
      for (const target of snapshot()?.targets ?? []) {
        lines.push(`${scopeLabel(target.scope)} — ${target.path}`)
      }
      if (!isAvailable("project")) lines.push(t("instanceServiceStatus.plugins.scope.unavailable"))
      if (state().error) lines.push(t("instanceServiceStatus.plugins.errors.refresh"))
      return lines.map(bidi).join("\n")
    }
    const renderSwitch = (scope: PluginControlScope) => {
      const labelId = scope === "global" ? globalLabelId : projectLabelId
      return <PluginActivationSwitch instanceId={props.instanceId} location={requestLocation()} control={control()} scope={scope}
        lockedReason={scope === "project" && integration()?.family === "native" ? t("integrations.section.scopeGlobalOnly") : undefined}
        available={isAvailable(scope)} active={props.active} describedBy={isAvailable(scope) ? labelId : `${labelId} ${noticeId}`}
        integration={Boolean(integration())} name={name()}
        label={bidi(t("instanceServiceStatus.plugins.toggleAriaLabel", { name: `${name()} — ${scopeLabel(scope)}` }))} />
    }
    const nameId = `${headingId}-name-${pluginId}`
    return (
      <div class="plugin-control-row" data-plugin-id={pluginId} data-integration={integration()?.id} role="group" aria-labelledby={nameId}
        aria-describedby={`${nameId}-details`}>
        <div class="plugin-control-identity"><PluginName id={nameId} name={name()} details={details()} version={version()} />
          {nonConformingLabel(declarationsFor(matchesControl))}<PluginRowActions instanceId={props.instanceId} location={requestLocation()} name={name()}
          source={control()?.runtime?.source} removable={removable()} refresh={refresh} active={props.active} consentEpoch={consentEpoch()} sessionId={props.session?.id}
          info={connection()} hostAction={hostAction()} docs={integration()?.docs} /></div>
        {renderSwitch("global")}
        {renderSwitch("project")}
        <Show when={line()}>{value => <IntegrationStateLineView line={value()} binding={binding}
          install={() => { const entry = integration(); if (entry) void installation.open(entry.id) }} />}</Show>
      </div>
    )
  }

  const removableFor = (target: string) => createMemo(() => removableSources(snapshot(), source => source.target === target), [], {
    equals: (left, right) => left.length === right.length && left.every((source, index) => sameSource(source, right[index]!)),
  })

  const renderRuntime = (target: string) => {
    const entry = () => runtimesByTarget().get(target)
    const nameId = createUniqueId()
    const removable = removableFor(target)
    const integration = () => recognised().byTarget.get(target)
    const packageVersion = () => { const source = entry()?.source; return source?.type === "package" ? source.version : undefined }
    const details = () => {
      const current = entry()
      const lines = current ? runtimeLines(current) : [target]
      if (integration()) lines.unshift(t("instanceServiceStatus.plugins.kind.integration", { id: integration()!.displayName }))
      lines.push(...guiNotice(current, declarationsFor(source => source.target === target)))
      return lines.map(bidi).join("\n")
    }
    return <div class="plugin-control-row" data-package-target={entry()?.source.type === "package" ? target : undefined}
      data-local-path={entry()?.source.type === "local" ? target : undefined} data-integration={integration()?.id} role="group" aria-labelledby={nameId}
      aria-describedby={`${nameId}-details`}>
      <div class="plugin-control-identity">
        <PluginName id={nameId} name={integration()?.displayName ?? target} details={details()} version={packageVersion()} />
        {nonConformingLabel(declarationsFor(source => source.target === target))}
        <PluginRowActions instanceId={props.instanceId} location={requestLocation()} name={target} source={entry()?.source}
          removable={removable()} refresh={refresh} active={props.active} consentEpoch={consentEpoch()} sessionId={props.session?.id}
          docs={integration()?.docs} />
      </div>
      <Show when={integration()}>{value => <IntegrationStateLineView line={integrationStateLine({ entry: value(), conversation: false, canInstall: false })} />}</Show>
    </div>
  }

  // Configured or just-added sources absent from the inventory. Pending rows stay busy until
  // `plugin.list` reports the target (it then becomes an ordinary row) or the window closes.
  const renderSource = (target: string) => {
    const nameId = createUniqueId()
    const removable = removableFor(target)
    const state = () => pluginSourcesStore.state(props.instanceId, requestLocation(), target)
    const integration = () => recognised().byTarget.get(target)
    const details = () => [
      ...(integration() ? [t("instanceServiceStatus.plugins.kind.integration", { id: integration()!.displayName })] : []),
      t("instanceServiceStatus.plugins.source.package", { source: target }),
      t(state() === "pending" ? "instanceServiceStatus.plugins.sources.pending" : "instanceServiceStatus.plugins.sources.unconfirmed"),
      ...declarationsFor(source => source.target === target).map(source => source.scope === "global" || source.scope === "project"
        ? `${scopeLabel(source.scope)} — ${source.path ?? ""}` : source.path ?? ""),
    ].map(bidi).join("\n")
    return <div class="plugin-control-row" data-source-target={target} data-source-state={state()} data-integration={integration()?.id}
      role="group" aria-labelledby={nameId} aria-describedby={`${nameId}-details`} aria-busy={state() === "pending"}>
      <div class="plugin-control-identity">
        <PluginName id={nameId} name={integration()?.displayName ?? target} details={details()} />
        <Show when={state() === "pending"} fallback={<span class="plugin-source-state" role="status">{t("instanceServiceStatus.plugins.sources.unconfirmedLabel")}</span>}>
          <span class="plugin-source-state" role="status">
            <Loader2 class="h-3 w-3 animate-spin" aria-hidden="true" />{t("instanceServiceStatus.plugins.sources.pendingLabel")}
          </span>
        </Show>
        {nonConformingLabel(declarationsFor(source => source.target === target))}
        <PluginRowActions instanceId={props.instanceId} location={requestLocation()} name={target} removable={removable()}
          refresh={state() === "unconfirmed" ? refresh : undefined} active={props.active} consentEpoch={consentEpoch()} sessionId={props.session?.id} />
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
      <PluginSystemAttention instanceId={props.instanceId} location={requestLocation()} snapshot={snapshot()} active={props.active}
        runtimeUnconfirmed={state().runtimeUnconfirmed}
        restoreFocus={() => refreshButton?.focus()} />
      <div class="plugin-controls-header">
        <div class="plugin-controls-header-actions">
          <button
            ref={refreshButton}
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
          <Show when={snapshot()}>
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
        <Show when={controlIds().length + runtimeTargets().length + sourceTargets().length > 0} fallback={<p class="right-panel-empty-text">{t("instanceServiceStatus.plugins.empty")}</p>}>
          <div class="plugin-control-list">
            <For each={controlIds()}>{renderControl}</For>
            <For each={runtimeTargets()}>{renderRuntime}</For>
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

/**
 * A row's name and version. Details use the native `title` like the rest of the app, and a hidden copy that the row
 * names through `aria-describedby` (`<id>-details`) for keyboard and screen-reader users.
 */
function PluginName(props: { id: string; name: string; details: string; version?: string }): JSX.Element {
  return <span class="plugin-control-title">
    <span id={props.id} class="plugin-control-name" title={props.details}><bdi>{props.name}</bdi></span>
    <Show when={props.version}>{value => <span class="plugin-control-version"><bdi>{value()}</bdi></span>}</Show>
    <span id={`${props.id}-details`} class="sr-only">{props.details}</span>
  </span>
}

function sourcesOverlap(left: readonly Pick<PluginConfiguredSource, "scope" | "entryIndex">[], right: readonly Pick<PluginConfiguredSource, "scope" | "entryIndex">[]): boolean {
  return left.some(source => right.some(other => other.scope === source.scope && other.entryIndex === source.entryIndex))
}

export function sameSource(left: PluginConfiguredSource, right: PluginConfiguredSource): boolean {
  return left.scope === right.scope && left.target === right.target && left.entryIndex === right.entryIndex && left.path === right.path && left.expectedRevision === right.expectedRevision
}
