import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, type Component } from "solid-js"
import { Tooltip } from "@kobalte/core/tooltip"
import { Loader2, RefreshCw } from "lucide-solid"
import Switch from "@suid/material/Switch"
import type {
  PluginActivationControl,
  PluginConfiguredSource,
  PluginControlLocation,
  PluginControlScope,
  PluginRuntimeInventoryEntry,
  PluginRuntimeSource,
} from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { showToastNotification } from "../lib/notifications"
import { HttpResponseError } from "../lib/retryable-file-search"
import { pluginControlsCache } from "../stores/plugin-controls"
import { pluginSourcesStore, removableSources } from "../stores/plugin-sources"
import { PluginRowActions } from "./plugin-row-actions"
import { PluginSourceAdd } from "./plugin-source-add"
import "../stores/plugin-controls-events"
import { createIntegrationAttachment } from "./integration-attachment"
import { integrations } from "../stores/integrations"
import { createIntegrationHostInstallation } from "./integration-host-installation"

interface PluginActivationControlsProps {
  instanceId: string
  location: PluginControlLocation
  active?: boolean
  session?: { id: string; title?: string; metadata?: Record<string, unknown> }
}

const log = getLogger("session")

const pendingKey = (scope: PluginControlScope, pluginId: string): string => `${scope}:${pluginId}`

export const PluginActivationControls: Component<PluginActivationControlsProps> = (props) => {
  const { t } = useI18n()
  const [pending, setPending] = createSignal<Set<string>>(new Set())
  const headingId = `plugin-controls-${createUniqueId()}`
  const noticeId = `${headingId}-notice`
  const globalLabelId = `plugin-controls-${createUniqueId()}-global`
  const projectLabelId = `plugin-controls-${createUniqueId()}-project`
  const directory = createMemo(() => props.location.directory)
  const attachment = createIntegrationAttachment({
    get instanceId() { return props.instanceId }, get directory() { return directory() },
    get session() { return props.session }, get active() { return props.active },
  })
  const catalogUnavailable = () => {
    const value = attachment.state()
    return value.status === "error" || (value.status === "ready" && value.refreshError) || attachment.response()?.catalog.state === "unavailable"
  }
  const installation = createIntegrationHostInstallation({
    get instanceId() { return props.instanceId }, get directory() { return directory() },
    get sessionId() { return props.session?.id }, get active() { return props.active }, entries: attachment.entries,
  })
  const installFor = (sources: readonly (PluginConfiguredSource & { scope: PluginControlScope })[]) => {
    const entry = integrationFor(sources), action = entry && installation.action(entry.id)
    return entry && action ? { action, run: () => installation.open(entry.id) } : undefined
  }
  const integrationFor = (sources: readonly (PluginConfiguredSource & { scope: PluginControlScope })[]) => attachment.entries().find(entry =>
    entry.configuredSources.some(association => sources.some(source => source.scope === association.scope && source.entryIndex === association.entryIndex)))
  const attachFor = (sources: readonly (PluginConfiguredSource & { scope: PluginControlScope })[]) => {
    const entry = integrationFor(sources)
    return entry && attachment.canAttach(entry.id) ? () => attachment.open(entry.id) : undefined
  }
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
    for (const source of snapshot()?.configured.sources ?? []) {
      if (!source.pluginId && !loaded.has(source.target)) targets.add(source.target)
    }
    return [...targets]
  })
  const projectAvailable = () => snapshot()?.targets.some((target) => target.scope === "project") === true
  let currentIdentity: string | undefined
  let locationGeneration = 0
  // The admitted write may finish after a project tab or visibility wrapper
  // disposes this surface. Only its live owner may publish presentation feedback.
  onCleanup(() => { locationGeneration += 1 })

  createEffect(() => {
    const instanceId = props.instanceId
    const location = requestLocation()
    const identity = JSON.stringify([instanceId, location.directory])
    if (currentIdentity !== identity) {
      currentIdentity = identity
      locationGeneration += 1
      setPending(new Set<string>())
    }
    if (props.active === false) return
    onCleanup(pluginControlsCache.acquireDemand(instanceId, location))
  })

  const setPendingPlugin = (scope: PluginControlScope, pluginId: string, value: boolean) => {
    setPending((previous) => {
      const next = new Set(previous)
      if (value) next.add(pendingKey(scope, pluginId))
      else next.delete(pendingKey(scope, pluginId))
      return next
    })
  }

  const toggle = async (control: PluginActivationControl, scope: PluginControlScope, enabled: boolean) => {
    const key = pendingKey(scope, control.id)
    if (pending().has(key)) return
    const requestGeneration = locationGeneration
    setPendingPlugin(scope, control.id, true)
    try {
      await pluginControlsCache.mutate(props.instanceId, requestLocation(), control.id, scope, enabled)
    } catch (error) {
      log.error("Failed to update plugin activation rule", { pluginId: control.id, scope, error })
      if (requestGeneration === locationGeneration && props.active !== false) {
        showToastNotification({ category: "opencode",
          variant: "error",
          message: t(errorMessageKey(error), { name: control.id, scope: scopeLabel(scope) }),
        })
      }
    } finally {
      if (requestGeneration === locationGeneration) setPendingPlugin(scope, control.id, false)
    }
  }

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
      if (!isAvailable("project")) lines.push(t("instanceServiceStatus.plugins.scope.unavailable"))
      if (state().error) lines.push(t("instanceServiceStatus.plugins.errors.refresh"))
      return lines.map(bidi).join("\n")
    }
    const renderSwitch = (scope: PluginControlScope) => {
      const checked = () => {
        const current = control()
        return current ? scopeChecked(current, scope) : false
      }
      const available = () => isAvailable(scope)
      const isPending = () => pending().has(pendingKey(scope, pluginId))
      const describedBy = () => available()
        ? (scope === "global" ? globalLabelId : projectLabelId)
        : `${scope === "global" ? globalLabelId : projectLabelId} ${noticeId}`
      return (
        <div
          class="plugin-control-switch"
          data-scope={scope}
        >
          <Switch
            checked={checked()}
            disabled={!available()}
            color="success"
            size="small"
            inputProps={{
              "aria-label": bidi(t("instanceServiceStatus.plugins.toggleAriaLabel", {
                name: `${pluginId} — ${scopeLabel(scope)}`,
              })),
              "aria-describedby": describedBy(),
              "aria-disabled": isPending() || !available(),
              "aria-busy": isPending(),
            }}
            onChange={(event, nextChecked) => {
              const current = control()
              if (isPending() || !available() || !current) {
                // SUID restores the controlled checked value before calling us.
                // Cancel native activation too, while retaining keyboard focus.
                event.preventDefault()
                return
              }
              void toggle(current, scope, Boolean(nextChecked))
            }}
          />
        </div>
      )
    }
    const nameId = `${headingId}-name-${pluginId}`
    return (
      <div class="plugin-control-row" data-plugin-id={pluginId} role="group" aria-labelledby={nameId}>
        <div class="plugin-control-identity"><Tooltip placement="top-start" openDelay={300}>
          <Tooltip.Trigger as="span" tabindex="0" id={nameId} class="plugin-control-name"><bdi>{pluginId}</bdi></Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="section-info-tooltip plugin-control-tooltip">{details()}</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip><PluginRowActions instanceId={props.instanceId} location={requestLocation()} name={pluginId}
          source={control()?.runtime?.source} removable={removable()} active={props.active} consentEpoch={consentEpoch()} sessionId={props.session?.id} attach={attachFor(removable())} installHost={installFor(removable())} /></div>
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
        <PluginRowActions instanceId={props.instanceId} location={requestLocation()} name={target} source={entry()?.source}
          removable={removable()} active={props.active} consentEpoch={consentEpoch()} sessionId={props.session?.id} attach={attachFor(removable())} installHost={installFor(removable())} />
      </div>
    </div>
  }

  // Configured or just-added sources absent from the inventory. Pending rows stay busy until
  // `plugin.list` reports the target (it then becomes an ordinary row) or the window closes.
  const renderSource = (target: string) => {
    const nameId = createUniqueId()
    const removable = removableFor(target)
    const state = () => declarationsFor(source => source.target === target).some(source => (source.scope === "global" || source.scope === "project")
      && pluginSourcesStore.state(props.instanceId, requestLocation(), target, source.scope, source.trackingTarget) === "pending") ? "pending" : "unconfirmed"
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
        <PluginRowActions instanceId={props.instanceId} location={requestLocation()} name={target} removable={removable()}
          refresh={state() === "unconfirmed" ? refresh : undefined} active={props.active} consentEpoch={consentEpoch()} sessionId={props.session?.id} attach={attachFor(removable())} installHost={installFor(removable())} />
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
      <Show when={catalogUnavailable()}>
        <p class="right-panel-empty-text" role="status">{t("integrations.catalogUnavailable")}</p>
      </Show>
      <Show when={attachment.response()?.catalog.state === "stale"}>
        <p class="right-panel-empty-text" role="status">{t("integrations.catalogStale", { fetchedAt: attachment.response()?.catalog.fetchedAt ?? "" })}</p>
      </Show>
      <Show when={attachment.unsupported()}><p class="right-panel-empty-text">{t("integrations.unsupported")}</p></Show>
      {attachment.picker()}

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
          <Show when={snapshot()}>
            <PluginSourceAdd instanceId={props.instanceId} location={requestLocation()} projectAvailable={projectAvailable()} active={props.active} />
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

function sameSource(left: PluginConfiguredSource, right: PluginConfiguredSource): boolean {
  return left.scope === right.scope && left.target === right.target && left.entryIndex === right.entryIndex && left.path === right.path && left.expectedRevision === right.expectedRevision
}

function scopeChecked(control: PluginActivationControl, scope: PluginControlScope): boolean {
  const scoped = control[scope]
  if (scoped !== "default") return scoped === "enabled"
  return scope === "project" ? scopeChecked(control, "global") : true
}

function errorMessageKey(error: unknown): string {
  if (!(error instanceof HttpResponseError)) return "instanceServiceStatus.plugins.errors.save"
  if (error.status === 403) return "instanceServiceStatus.plugins.errors.forbidden"
  if (error.status === 409) return "instanceServiceStatus.plugins.errors.conflict"
  if (error.status === 422) return "instanceServiceStatus.plugins.errors.invalidConfig"
  return "instanceServiceStatus.plugins.errors.save"
}
