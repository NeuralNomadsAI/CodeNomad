import type { LocationRef } from "@opencode/client"
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js"
import { agentMemoryFor, AgentMemoryError } from "../../lib/agent-memory-api"
import { useI18n } from "../../lib/i18n"
import { backendEvents as serverEvents } from "../../lib/server-events"
import { createAgentMemoryReview } from "../../stores/agent-memory"
import { AgentMemoryEditor } from "./agent-memory-editor"
import { SettingsInfoTip } from "./settings-info-tip"
import { SettingsSwitch } from "./settings-switch"
import { showConfirmDialog } from "../../stores/alerts"
import { requestMemoryCleanup } from "../../lib/native/memory-cleanup"
import { generateUUID } from "../../lib/client-identity"
import { parseInstanceKey } from "../../lib/backend-identity"

export function AgentMemorySettingsCard(props: { instanceId?: string; serverId?: string; location?: LocationRef; unavailable?: boolean }) {
  const { t } = useI18n(), id = createUniqueId()
  const [enabled, setEnabled] = createSignal<boolean>(), [changing, setChanging] = createSignal(false)
  const [settingsError, setSettingsError] = createSignal(false)
  const context = createMemo(() => props.instanceId ? { workspaceId: props.instanceId, ...(props.location?.directory ? { directory: props.location.directory } : {}) } : undefined)
  const api = createMemo(() => { serverEvents.signalForInstance(props.instanceId ?? ""); return agentMemoryFor(props.instanceId) })
  const review = createAgentMemoryReview(context, () => enabled() === true, api, () => parseInstanceKey(props.instanceId ?? "").backendId)
  const [tidying, setTidying] = createSignal(false), [tidyError, setTidyError] = createSignal(false)
  const [admitted, setAdmitted] = createSignal(false)
  let cleanupConsent = new AbortController()
  const cleanupOwner = createMemo(() => JSON.stringify([context(), props.serverId, review.scope(), enabled()]))
  createEffect(() => { cleanupOwner(); cleanupConsent.abort(); cleanupConsent = new AbortController(); setTidyError(false); setAdmitted(false) })
  onCleanup(() => cleanupConsent.abort())
  const canTidy = () => enabled() === true && !!context()?.directory && review.available() && review.hasSnapshot() &&
    !review.loading() && !review.busy() && !review.error() && !settingsError() && !changing() && !tidying() && !admitted() && review.cleanupWritable() && review.entries().some(entry => !entry.flagged)
  const tidy = async () => {
    if (!canTidy()) return
    const owner = cleanupOwner(), project = context()!, scope = review.scope()
    setTidying(true)
    try {
      if (!(await review.discard()) || owner !== cleanupOwner() || disposed) return
      if (!(await showConfirmDialog(t("settings.memory.tidyConfirm", { scope: t(`settings.memory.${scope}`) }), {
        confirmLabel: t("settings.memory.tidy"), cancelLabel: t("settings.memory.cancel"),
      }, cleanupConsent.signal)) || owner !== cleanupOwner() || disposed) return
      setAdmitted(true)
      await requestMemoryCleanup({ id: generateUUID(), scope, workspaceId: project.workspaceId, directory: project.directory!,
        ...(props.serverId ? { serverId: props.serverId } : {}) })
    } catch { if (!disposed && owner === cleanupOwner()) setTidyError(true) }
    finally { if (!disposed) setTidying(false) }
  }
  let sequence = 0, disposed = false
  const loadSettings = async () => {
    if (props.unavailable) return
    const request = ++sequence
    try {
      const value = await api().settings()
      if (typeof value.enabled !== "boolean") throw new AgentMemoryError("unreadable")
      if (!disposed && request === sequence) { setEnabled(value.enabled); setSettingsError(false) }
    } catch { if (!disposed && request === sequence) setSettingsError(true) }
  }
  const change = async (next: boolean) => {
    const owner = api()
    if (props.unavailable || changing() || !(await review.discard()) || disposed || props.unavailable || owner !== api()) return
    const request = ++sequence
    setChanging(true)
    try {
      const value = await owner.setEnabled(next)
      if (typeof value.enabled !== "boolean") throw new AgentMemoryError("unreadable")
      if (!disposed && request === sequence) { setEnabled(value.enabled); setSettingsError(false) }
    } catch { if (!disposed && request === sequence) { await loadSettings(); setSettingsError(true) } }
    finally { if (!disposed) setChanging(false) }
  }
  createEffect(() => {
    api()
    setEnabled(undefined)
    if (props.unavailable) { sequence++; setSettingsError(false); return }
    const refresh = () => { if (!changing()) void loadSettings() }
    const events = serverEvents.forInstance(() => props.instanceId ?? "")
    const reconnect = events.onOpen(refresh), changed = events.on("memory.changed", refresh)
    void loadSettings()
    onCleanup(() => { sequence++; reconnect(); changed() })
  })
  onCleanup(() => { disposed = true; sequence++ })
  const readOnly = () => !!review.error() || review.busy() || changing()
  const badge = (createdAt: string, updatedAt: string) => Date.parse(createdAt) > review.baseline() ? "new" : Date.parse(updatedAt) > review.baseline() ? "modified" : undefined
  return <section id="agent-memory" class="settings-card agent-memory" aria-labelledby={`${id}-heading`}>
    <div class="settings-card-header">
      <h3 id={`${id}-heading`} class="settings-card-title">{t("settings.memory.title")}<SettingsInfoTip text={t("settings.memory.info")} help={{ page: "settings", anchor: "agent-memory" }} /></h3>
      <SettingsSwitch label={t("settings.memory.title")} checked={enabled() === true} disabled={enabled() === undefined || changing()} onChange={next => void change(next)} />
    </div>
    <Show when={settingsError()}><div role="alert" class="agent-memory-actions"><span>{t("settings.memory.error.unavailable")}</span><button type="button" class="window-action" disabled={changing()} onClick={() => void loadSettings()}>{t("settings.memory.retry")}</button></div></Show>
    <Show when={props.unavailable}><p role="status">{t("settings.memory.noProject")}</p></Show>
    <Show when={enabled()}>
      <div class="agent-memory-toolbar">
        <label for={`${id}-scope`} class="sr-only">{t("settings.memory.scope")}</label>
        <select id={`${id}-scope`} value={review.scope()} disabled={review.busy()} onChange={event => {
          const value = event.currentTarget.value as "global" | "project"
          event.currentTarget.value = review.scope()
          void review.changeScope(value)
        }}><option value="global">{t("settings.memory.global")}</option><option value="project" disabled={!context()}>{t("settings.memory.project")}</option></select>
        <Show when={review.available() && review.hasSnapshot()}><span class="agent-memory-counter">{t("settings.memory.count", { count: review.entries().length, limit: review.scope() === "global" ? 60 : 200 })}</span></Show>
        <span class="agent-memory-tidy"><button type="button" class="window-action" disabled={!canTidy()} onClick={() => void tidy()}>{t("settings.memory.tidy")}</button><SettingsInfoTip text={t("settings.memory.tidyInfo")} help={{ page: "settings", anchor: "agent-memory" }} /></span>
      </div>
      <Show when={tidyError()}><p role="alert">{t("settings.memory.tidyFailed")}</p></Show>
      <Show when={!review.available()}><p role="status">{t("settings.memory.noProject")}</p></Show>
      <Show when={review.loading()}><p role="status">{t("settings.memory.loading")}</p></Show>
      <Show when={review.error()}>{error => <div role="alert" class="agent-memory-error">
        <span>{t(`settings.memory.error.${error().code}`)}</span>
        <Show when={error().titles?.length}><ul><For each={error().titles}>{title => <li><bdi>{title}</bdi></li>}</For></ul></Show>
        <button type="button" class="window-action" disabled={review.loading()} onClick={() => void (error().code === "conflict" ? review.reload() : review.load())}>{t(error().code === "conflict" ? "settings.memory.reload" : "settings.memory.retry")}</button>
      </div>}</Show>
      <Show when={review.available() && !review.loading() && !review.error() && !review.entries().length}><p role="status">{t("settings.memory.empty")}</p></Show>
      <ul class="agent-memory-list"><For each={review.entries()}>{entry => <li>
        <button type="button" class="agent-memory-entry" aria-expanded={review.draft()?.entry.id === entry.id} aria-controls={review.draft()?.entry.id === entry.id ? `${id}-editor` : undefined} disabled={review.busy()} onClick={() => void review.open(entry)}>
          <bdi class="agent-memory-entry-title">{entry.title}</bdi><span class="agent-memory-entry-type">{t(`settings.memory.type.${entry.type}`)}</span>
          <Show when={badge(entry.createdAt, entry.updatedAt)}>{state => <span class="badge-shape agent-memory-badge">{t(`settings.memory.${state()}`)}</span>}</Show>
          <Show when={entry.flagged}><span class="badge-shape agent-memory-badge">{t("settings.memory.flagged")}</span></Show>
        </button>
      </li>}</For></ul>
      <Show when={review.available() && review.draft()}><AgentMemoryEditor id={`${id}-editor`} review={review} readOnly={readOnly()} /></Show>
    </Show>
  </section>
}
