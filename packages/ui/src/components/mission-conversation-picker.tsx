import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { SessionInfo } from "@opencode/client"
import { useI18n } from "../lib/i18n"
import { getRootClient } from "../stores/opencode-client"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { buildProjectSessionListOptions } from "../stores/session-list-options"
import { sessions } from "../stores/session-state"

/** Reuses the native paged title search without changing the sidebar's search. */
export function MissionConversationPicker(props: {
  instanceId: string; directory?: string; projectID?: string; value: string[]
  disabled: boolean; active: () => boolean; onChange: (ids: string[]) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = createSignal(false), [query, setQuery] = createSignal("")
  const [cursor, setCursor] = createSignal<string>(), [next, setNext] = createSignal<string>()
  const [rows, setRows] = createSignal<SessionInfo[]>([])
  const [labels, setLabels] = createSignal<Record<string, string>>({})
  const [loading, setLoading] = createSignal(false), [failed, setFailed] = createSignal(false)
  const [revision, setRevision] = createSignal(0)
  const identity = () => JSON.stringify([props.instanceId, props.directory, props.projectID, getOpenCodeInstanceGeneration(props.instanceId)])
  createEffect(() => {
    const key = identity(), search = query().trim(), page = cursor(); revision()
    if (!open() || !props.active() || props.disabled) return
    const controller = new AbortController()
    let alive = true
    const current = () => alive && props.active() && identity() === key
    setLoading(true); setFailed(false)
    if (!page) setRows([])
    const timer = setTimeout(() => {
      void getRootClient(props.instanceId).session.list(buildProjectSessionListOptions({
        ...(page ? { cursor: page } : props.directory ? { directory: props.directory } : { project: props.projectID }),
        search, order: "desc",
      }), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) }).then(result => {
        if (!current()) return
        setRows(previous => page ? [...previous, ...result.data.filter(row => !previous.some(item => item.id === row.id))] : result.data)
        setLabels(previous => ({ ...previous, ...Object.fromEntries(result.data.map(row => [row.id, row.title || t("sessionPicker.session.untitled")])) }))
        setNext(result.cursor?.next ?? undefined)
      }).catch(() => { if (current()) setFailed(true) }).finally(() => { if (current()) setLoading(false) })
    }, search ? 200 : 0)
    onCleanup(() => { alive = false; clearTimeout(timer); controller.abort() })
  })
  return <div class="mission-conversation-picker">
    <span>{t("missions.recurrence.followedConversations")}</span>
    <For each={props.value}>{id => <label class="mission-conversation-option" title={id}>
      <input type="checkbox" checked disabled={props.disabled} onChange={() => props.onChange(props.value.filter(value => value !== id))} />
      <span>{labels()[id] ?? sessions().get(props.instanceId)?.get(id)?.title ?? t("missions.recurrence.selectedConversation")}</span>
    </label>}</For>
    <details class="mission-profile-optional" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{t("missions.recurrence.chooseConversations")}</summary>
      <label>{t("sessionList.filter.ariaLabel")}<input type="search" value={query()} disabled={props.disabled}
        onInput={event => { setCursor(undefined); setQuery(event.currentTarget.value) }} /></label>
      <div class="mission-conversation-results">
        <For each={rows().filter(row => !props.value.includes(row.id))}>{row => <label class="mission-conversation-option" title={row.id}>
          <input type="checkbox" checked={false} disabled={props.disabled || props.value.length >= 32}
            onChange={() => props.onChange([...props.value, row.id])} />
          <span>{row.title || t("sessionPicker.session.untitled")}</span>
        </label>}</For>
      </div>
      <Show when={loading()}><p role="status">{t("missions.control.loading")}</p></Show>
      <Show when={failed()}><p role="alert">{t("missions.recurrence.conversationsUnavailable")}</p>
        <button type="button" class="window-action" disabled={loading() || props.disabled} onClick={() => setRevision(value => value + 1)}>{t("missions.control.refresh")}</button></Show>
      <Show when={!loading() && !failed() && !rows().length}><p>{t("missions.recurrence.noConversations")}</p></Show>
      <Show when={next() && !failed()}><button type="button" class="window-action" disabled={loading() || props.disabled}
        onClick={() => setCursor(next())}>{t("missions.recurrence.moreConversations")}</button></Show>
    </details>
  </div>
}
