import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { SkillInfo } from "@opencode/client"
import { useI18n } from "../../lib/i18n"
import { getRootClient } from "../../stores/opencode-client"
import { addAttachment, getAttachments, removeAttachment } from "../../stores/attachments"
import { createSkillAttachment } from "../../types/attachment"
import { serverEvents } from "../../lib/server-events"

type SkillSummary = Pick<SkillInfo, "id" | "name" | "description">

export default function SkillAttachments(props: {
  instanceId: string
  sessionId: string
  directory: string
  active: boolean
  disabled: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = createSignal(false)
  const [items, setItems] = createSignal<SkillSummary[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  const selected = () => getAttachments(props.instanceId, props.sessionId).filter(item => item.source.type === "skill")
  // Each visible demand reads the owning native Location, with no cross-session
  // cache of skill content. A view/directory change fences late responses.
  createEffect(() => {
    const instanceId = props.instanceId, sessionId = props.sessionId, directory = props.directory
    const active = props.active
    let disposed = false, inFlight = false, trailing = false
    setItems([])
    setError(false)
    setLoading(false)
    if (!active || !open()) return
    const refresh = async () => {
      if (disposed) return
      if (inFlight) { trailing = true; return }
      inFlight = true
      setLoading(true)
      do {
        trailing = false
        try {
          const response = await getRootClient(instanceId).skill.list({ location: { directory } })
          if (!disposed && !trailing) {
            setItems(response.data.map(({ id, name, description }) => ({ id, name, description })))
            setError(false)
          }
        } catch { if (!disposed && !trailing) setError(true) }
      } while (!disposed && trailing)
      inFlight = false
      if (!disposed) setLoading(false)
    }
    const unsubscribe = serverEvents.on("instance.event", payload => {
      if (payload.type !== "instance.event" || payload.instanceId !== instanceId) return
      if (["skill.updated", "config.updated"].includes(payload.event.type)) void refresh()
    })
    const status = serverEvents.on("instance.eventStatus", payload => {
      if (payload.type === "instance.eventStatus" && payload.instanceId === instanceId && payload.status === "connected") void refresh()
    })
    const reconnect = serverEvents.onOpen(() => { void refresh() })
    onCleanup(() => { disposed = true; unsubscribe(); status(); reconnect() })
    void refresh()
  })
  createEffect(() => { if (!props.active) setOpen(false) })
  return <div class="prompt-skill-attachments">
    <button type="button" class="selector-button" disabled={props.disabled} aria-expanded={open()}
      onClick={() => setOpen(value => !value)}>{t("promptInput.skills.title")}</button>
    <For each={selected()}>{item => <button type="button" class="badge-shape selector-button" disabled={props.disabled}
      aria-label={t("promptInput.skills.remove", { name: item.filename })}
      onClick={() => removeAttachment(props.instanceId, props.sessionId, item.id)}>{item.filename} ×</button>}</For>
    <Show when={open()}>
      <select class="selector-trigger" aria-label={t("promptInput.skills.title")} disabled={props.disabled || loading()}
        value="" onChange={event => {
          const skill = items().find(item => item.id === event.currentTarget.value)
          if (skill && !selected().some(item => item.source.type === "skill" && item.source.id === skill.id)) {
            addAttachment(props.instanceId, props.sessionId, createSkillAttachment(skill.id, skill.name))
          }
          event.currentTarget.value = ""
        }}>
        <option value="">{t(loading() ? "promptInput.skills.loading" : "promptInput.skills.select")}</option>
        <For each={items()}>{skill => <option value={skill.id} title={skill.description}>{skill.name}</option>}</For>
      </select>
      <Show when={error()}><span role="alert">{t("promptInput.skills.error")}</span></Show>
      <Show when={!loading() && !error() && items().length === 0}><span>{t("promptInput.skills.empty")}</span></Show>
    </Show>
  </div>
}
