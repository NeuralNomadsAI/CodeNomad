import type { LocationRef } from "@opencode/client"
import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js"
import { agentMemoryApi, AgentMemoryError } from "../../lib/agent-memory-api"
import { useI18n } from "../../lib/i18n"
import { serverEvents } from "../../lib/server-events"
import { createAgentMemoryReview } from "../../stores/agent-memory"
import { AgentMemoryEditor } from "./agent-memory-editor"
import { SettingsInfoTip } from "./settings-info-tip"
import { SettingsSwitch } from "./settings-switch"

export function AgentMemorySettingsCard(props: { instanceId?: string; location?: LocationRef }) {
  const { t } = useI18n(), id = createUniqueId()
  const [enabled, setEnabled] = createSignal<boolean>(), [changing, setChanging] = createSignal(false)
  const [settingsError, setSettingsError] = createSignal(false)
  const context = createMemo(() => props.instanceId ? { workspaceId: props.instanceId, ...(props.location?.directory ? { directory: props.location.directory } : {}) } : undefined)
  const review = createAgentMemoryReview(context, () => enabled() === true)
  let sequence = 0, disposed = false
  const loadSettings = async () => {
    const request = ++sequence
    try {
      const value = await agentMemoryApi.settings()
      if (typeof value.enabled !== "boolean") throw new AgentMemoryError("unreadable")
      if (!disposed && request === sequence) { setEnabled(value.enabled); setSettingsError(false) }
    } catch { if (!disposed && request === sequence) setSettingsError(true) }
  }
  const change = async (next: boolean) => {
    if (changing() || !(await review.discard()) || disposed) return
    const request = ++sequence
    setChanging(true)
    try {
      const value = await agentMemoryApi.setEnabled(next)
      if (typeof value.enabled !== "boolean") throw new AgentMemoryError("unreadable")
      if (!disposed && request === sequence) { setEnabled(value.enabled); setSettingsError(false) }
    } catch { await loadSettings(); if (!disposed) setSettingsError(true) }
    finally { if (!disposed) setChanging(false) }
  }
  onMount(() => {
    const refresh = () => { if (!changing()) void loadSettings() }
    const reconnect = serverEvents.onOpen(refresh), changed = serverEvents.on("memory.changed", refresh)
    void loadSettings()
    onCleanup(() => { disposed = true; sequence++; reconnect(); changed() })
  })
  const readOnly = () => !!review.error() || review.busy() || changing()
  const badge = (createdAt: string, updatedAt: string) => Date.parse(createdAt) > review.baseline() ? "new" : Date.parse(updatedAt) > review.baseline() ? "modified" : undefined
  return <section id="agent-memory" class="settings-card agent-memory" aria-labelledby={`${id}-heading`}>
    <div class="settings-card-header">
      <h3 id={`${id}-heading`} class="settings-card-title">{t("settings.memory.title")}<SettingsInfoTip text={t("settings.memory.info")} /></h3>
      <SettingsSwitch label={t("settings.memory.title")} checked={enabled() === true} disabled={enabled() === undefined || changing()} onChange={next => void change(next)} />
    </div>
    <Show when={settingsError()}><div role="alert" class="agent-memory-actions"><span>{t("settings.memory.error.unavailable")}</span><button type="button" class="window-action" disabled={changing()} onClick={() => void loadSettings()}>{t("settings.memory.retry")}</button></div></Show>
    <Show when={enabled()}>
      <div class="agent-memory-toolbar">
        <label for={`${id}-scope`} class="sr-only">{t("settings.memory.scope")}</label>
        <select id={`${id}-scope`} value={review.scope()} disabled={review.busy()} onChange={event => {
          const value = event.currentTarget.value as "global" | "project"
          event.currentTarget.value = review.scope()
          void review.changeScope(value)
        }}><option value="global">{t("settings.memory.global")}</option><option value="project" disabled={!context()}>{t("settings.memory.project")}</option></select>
        <Show when={review.available() && review.hasSnapshot()}><span class="agent-memory-counter">{t("settings.memory.count", { count: review.entries().length, limit: review.scope() === "global" ? 60 : 200 })}</span></Show>
        {/* The maintenance action is supplied by the session-maintenance slice. */}
      </div>
      <Show when={!review.available()}><p role="status">{t("settings.memory.noProject")}</p></Show>
      <Show when={review.loading()}><p role="status">{t("settings.memory.loading")}</p></Show>
      <Show when={review.error()}>{error => <div role="alert" class="agent-memory-error">
        <span>{t(`settings.memory.error.${error().code}`)}</span>
        <Show when={error().titles?.length}><ul><For each={error().titles}>{title => <li>{title}</li>}</For></ul></Show>
        <button type="button" class="window-action" disabled={review.loading()} onClick={() => void (error().code === "conflict" ? review.reload() : review.load())}>{t(error().code === "conflict" ? "settings.memory.reload" : "settings.memory.retry")}</button>
      </div>}</Show>
      <Show when={review.available() && !review.loading() && !review.error() && !review.entries().length}><p role="status">{t("settings.memory.empty")}</p></Show>
      <ul class="agent-memory-list"><For each={review.entries()}>{entry => <li>
        <button type="button" class="agent-memory-entry" aria-expanded={review.draft()?.entry.id === entry.id} aria-controls={review.draft()?.entry.id === entry.id ? `${id}-editor` : undefined} disabled={review.busy()} onClick={() => void review.open(entry)}>
          <span class="agent-memory-entry-title">{entry.title}</span><span class="agent-memory-entry-type">{t(`settings.memory.type.${entry.type}`)}</span>
          <Show when={badge(entry.createdAt, entry.updatedAt)}>{state => <span class="badge-shape agent-memory-badge">{t(`settings.memory.${state()}`)}</span>}</Show>
          <Show when={entry.flagged}><span class="badge-shape agent-memory-badge">{t("settings.memory.flagged")}</span></Show>
        </button>
      </li>}</For></ul>
      <Show when={review.available() && review.draft()}><AgentMemoryEditor id={`${id}-editor`} review={review} readOnly={readOnly()} /></Show>
    </Show>
  </section>
}
