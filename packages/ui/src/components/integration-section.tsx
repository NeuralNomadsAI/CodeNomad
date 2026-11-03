import { Show, createMemo, type Accessor, type JSX } from "solid-js"
import { BookOpen, RefreshCw } from "lucide-solid"
import type { PluginControlLocation, PluginControlScope } from "../../../server/src/api-types"
import type { IntegrationView } from "../../../server/src/integration-types"
import { openExternalUrl } from "../lib/external-url"
import { useI18n } from "../lib/i18n"
import { integrationPlugin } from "../lib/integration-rows"
import { pluginControlsCache } from "../stores/plugin-controls"
import { pluginSourcesStore, removableSources } from "../stores/plugin-sources"
import { integrations } from "../stores/integrations"
import type { createIntegrationAttachment } from "./integration-attachment"
import type { createIntegrationHostInstallation } from "./integration-host-installation"
import { deriveIntegrationSectionState, type IntegrationSectionState } from "./integration-section-state"
import { InfoPopoverButton } from "./info-popover-button"
import { PluginActivationSwitch } from "./plugin-activation-switch"
import { PluginRowActions } from "./plugin-row-actions"

type Translate = (key: string, vars?: Record<string, any>) => string

/** What every section of one Status tab shares: its Location, displayed conversation and single attachment. */
export interface IntegrationSectionContext {
  instanceId: string
  location: Accessor<PluginControlLocation>
  session: Accessor<{ id: string } | undefined>
  active: Accessor<boolean>
  attachment: ReturnType<typeof createIntegrationAttachment>
  installation: ReturnType<typeof createIntegrationHostInstallation>
  /** The Plugins accordion trigger, focus fallback of controls that disappear. */
  pluginsTrigger: () => HTMLElement | null | undefined
}

/** The plugin-controls facts and the derived state of one integration, read on demand. */
export function integrationSectionFacts(context: IntegrationSectionContext, entry: IntegrationView) {
  const snapshot = pluginControlsCache.state(context.instanceId, context.location()).snapshot
  const plugin = integrationPlugin(snapshot, entry)
  const state = deriveIntegrationSectionState({
    entry,
    installation: pluginSourcesStore.installation(context.instanceId, context.location(), entry),
    disabled: plugin.control?.effective === "disabled",
    conversation: {
      present: Boolean(context.session()),
      binding: context.attachment.binding(entry.id),
      uncertain: context.attachment.uncertain(entry.id),
      hint: context.attachment.matchedHintLabel(entry.id),
    },
  })
  return { snapshot, plugin, state }
}

/** The catalogue summary in the current language, else English. */
export function integrationSummary(entry: IntegrationView, locale: string): string {
  return entry.summary[locale] ?? entry.summary[locale.split("-")[0]!] ?? entry.summary.en ?? Object.values(entry.summary)[0] ?? ""
}

const STATE_HINTS: Partial<Record<IntegrationSectionState["label"], string>> = {
  uncertain: "integrations.hint.uncertain", unconfirmed: "integrations.hint.unconfirmed", failed: "integrations.hint.failed",
  nonConforming: "integrations.hint.nonConforming", unsupported: "integrations.hint.unsupported", unknown: "integrations.hint.unknown",
  hostClosed: "integrations.hint.hostClosed", incompatible: "integrations.hint.incompatible", legacy: "integrations.hint.legacy",
}

/** The header's state label and cumulative update label, always visible. */
export function IntegrationSectionStatus(props: { t: Translate; state: IntegrationSectionState }) {
  return <span class="integration-section-status">
    <span class="integration-state-badge badge-shape" data-integration-state={props.state.label}>{props.t(`integrations.state.${props.state.label}`)}</span>
    <Show when={props.state.updateAvailable}>
      <span class="integration-state-badge badge-shape" data-integration-state="update">{props.t("integrations.section.updateAvailable")}</span>
    </Show>
  </span>
}

/** The header's Documentation icon, opened outside the application. */
export function IntegrationDocsButton(props: { t: Translate; docs?: string }) {
  return <Show when={props.docs}>{docs => (
    <button type="button" class="section-info-trigger integration-docs-trigger" aria-label={props.t("integrations.docs")} title={props.t("integrations.docs")}
      onClick={() => void openExternalUrl(docs(), "integration-docs")}>
      <BookOpen class="section-info-icon" aria-hidden="true" />
    </button>
  )}</Show>
}

/** The header's "i": the catalogue summary and the state's help. */
export function IntegrationInfoButton(props: { t: Translate; entry: IntegrationView; state: IntegrationSectionState }) {
  const { locale } = useI18n()
  const hint = () => STATE_HINTS[props.state.label]
  return <InfoPopoverButton label={props.t("integrations.info", { name: props.entry.displayName })}>
    <p>{integrationSummary(props.entry, locale())}</p>
    <Show when={hint()}>{key => <p>{props.t(key(), { app: props.entry.app.name })}</p>}</Show>
  </InfoPopoverButton>
}

function Line(props: { name: string; label: string; children: JSX.Element }) {
  return <div class="integration-section-line" data-line={props.name}>
    <span class="integration-section-line-label">{props.label}</span>
    <div class="integration-section-line-value">{props.children}</div>
  </div>
}

/** The body of one integration's Status section: Plugin, Application, Conversation and Connection lines. */
export function IntegrationSection(props: { t: Translate; entry: Accessor<IntegrationView | undefined>; context: IntegrationSectionContext }) {
  return <Show when={props.entry()}>{entry => <IntegrationSectionBody t={props.t} entry={entry} context={props.context} />}</Show>
}

function IntegrationSectionBody(props: { t: Translate; entry: Accessor<IntegrationView>; context: IntegrationSectionContext }) {
  const t = props.t
  const context = props.context
  const facts = createMemo(() => integrationSectionFacts(context, props.entry()))
  const state = () => facts().state
  const name = () => props.entry().displayName
  const scopeLabel = (scope: PluginControlScope) => t(`instanceServiceStatus.plugins.scope.${scope}`)
  const removable = createMemo(() => removableSources(facts().snapshot, source => facts().plugin.sources.includes(source)), [], {
    equals: (left, right) => left.length === right.length && left.every((source, index) => source.scope === right[index]!.scope
      && source.target === right[index]!.target && source.entryIndex === right[index]!.entryIndex && source.expectedRevision === right[index]!.expectedRevision),
  })
  const consentEpoch = () => pluginControlsCache.state(context.instanceId, context.location()).invalidationRevision
  const projectAvailable = () => facts().snapshot?.targets.some(target => target.scope === "project") === true
  const refresh = () => {
    void pluginControlsCache.load(context.instanceId, context.location(), { force: true })
    void integrations.refreshDemanded(context.instanceId)
  }
  const renderSwitch = (scope: PluginControlScope) => <PluginActivationSwitch instanceId={context.instanceId} location={context.location()}
    control={facts().plugin.control} scope={scope} active={context.active()} name={name()} caption={scopeLabel(scope)}
    available={scope === "global" || projectAvailable()}
    lockedReason={scope === "project" && props.entry().family === "native" ? t("integrations.section.scopeGlobalOnly") : undefined}
    label={`⁨${t("instanceServiceStatus.plugins.toggleAriaLabel", { name: `${name()} — ${scopeLabel(scope)}` })}⁩`} />

  const conversationAction = () => {
    const row = state().conversation
    if (!row) return undefined
    const integrationId = props.entry().id
    if (row.state === "noConversation") return { label: t("integrations.attach"), disabled: true, title: t("integrations.conversation.openOne") }
    if (row.state === "available") return { label: t("integrations.attach"), run: () => void context.attachment.open(integrationId) }
    if (row.state === "reattach") return { label: t("integrations.reattach", { label: row.label }), run: () => void context.attachment.open(integrationId) }
    if (row.state === "attached") return { label: t("integrations.detach"), run: () => void context.attachment.detach(integrationId) }
    if (row.state === "unknown" || row.state === "uncertain") return { label: t("integrations.refresh"), run: () => context.attachment.refresh(integrationId) }
    return undefined
  }
  const conversationText = () => {
    const row = state().conversation
    if (!row) return ""
    if (row.state === "attached") return t("integrations.conversation.attached", { label: row.label })
    if (row.state === "reattach") return t("integrations.conversation.available")
    return t(`integrations.conversation.${row.state}`)
  }

  return (
    <div class="integration-section" data-integration-section={props.entry().id} data-integration-family={props.entry().family}>
      <Line name="plugin" label={t("integrations.section.plugin")}>
        <Show when={props.entry().version}>{version => <span class="integration-section-version">{t("integrations.section.version", { version: version() })}</span>}</Show>
        <Show when={state().updateAvailable}><span class="integration-section-note">{t("integrations.section.updateAvailable")}</span></Show>
        <Show when={state().label === "unconfirmed" || state().label === "unknown"}>
          <button type="button" class="icon-button-compact" aria-label={t("integrations.refresh")} title={t("integrations.refresh")} onClick={refresh}>
            <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Show>
        <Show when={state().label === "legacy" && props.entry().docs}>
          <button type="button" class="window-text-button" onClick={() => void openExternalUrl(props.entry().docs!, "integration-docs")}>{t("integrations.guide")}</button>
        </Show>
        <span class="integration-section-actions">
          <Show when={facts().plugin.control}>
            {renderSwitch("global")}
            {renderSwitch("project")}
          </Show>
          <PluginRowActions instanceId={context.instanceId} location={context.location()} name={name()} source={facts().plugin.source}
            removable={removable()} refresh={refresh} active={context.active()} consentEpoch={consentEpoch()} sessionId={context.session()?.id}
            hidePaths focusFallback={context.pluginsTrigger} />
        </span>
      </Line>
      <Show when={state().application}>{application => (
        <Line name="application" label={t("integrations.section.application")}>
          <span data-application-state={application().state}>{t(`integrations.application.${application().state}`)}</span>
          <Show when={context.installation.action(props.entry().id)}>{action => (
            <button type="button" class="window-text-button" disabled={context.installation.pending()}
              onClick={() => void context.installation.open(props.entry().id)}>{t(`integrations.installHost.${action()}`)}</button>
          )}</Show>
          <InfoPopoverButton label={t("integrations.installHost.machine")}>
            <p>{t("integrations.installHost.machine")}</p>
            <Show when={application().state === "unknown"}><p>{t("integrations.hint.hostClosed", { app: props.entry().app.name })}</p></Show>
          </InfoPopoverButton>
        </Line>
      )}</Show>
      <Show when={state().conversation}>{row => (
        <Line name="conversation" label={t("integrations.section.conversation")}>
          <span data-conversation-state={row().state}><bdi>{conversationText()}</bdi></span>
          <Show when={conversationAction()}>{action => (
            <button type="button" class="window-text-button" data-conversation-action
              aria-disabled={action().disabled || context.attachment.busy(props.entry().id) ? "true" : undefined}
              aria-busy={context.attachment.busy(props.entry().id)} title={action().title}
              onClick={() => { if (!action().disabled && !context.attachment.busy(props.entry().id)) action().run?.() }}>
              {action().label}
            </button>
          )}</Show>
          <Show when={row().state === "noOffer"}>
            <InfoPopoverButton label={t("integrations.conversation.noOffer")}>
              <p>{t("integrations.conversation.noOfferHint", { app: props.entry().app.name })}</p>
            </InfoPopoverButton>
          </Show>
          <Show when={row().state === "unsupported"}>
            <InfoPopoverButton label={t("integrations.conversation.unsupported")}><p>{t("integrations.hint.unsupported")}</p></InfoPopoverButton>
          </Show>
        </Line>
      )}</Show>
      <Show when={state().connection}>{connection => (
        <Line name="connection" label={t("integrations.section.connection")}>
          <span data-connection-state={connection()}>{t(`integrations.connection.${connection()}`)}</span>
          <Show when={props.entry().family === "vendor-mcp" && props.entry().app.versions}>{versions => (
            <InfoPopoverButton label={t("integrations.connection.requires", { app: props.entry().app.name, versions: versions() })}>
              <p>{t("integrations.connection.requires", { app: props.entry().app.name, versions: versions() })}</p>
            </InfoPopoverButton>
          )}</Show>
        </Line>
      )}</Show>
    </div>
  )
}
