import { createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js"
import type { ConversationPermissionMode, ConversationPermissionModeResponse } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"
import { serverEvents } from "../../lib/server-events"
import { InfoPopoverButton } from "../info-popover-button"

const modes = ["autonomous", "supervised"] as const

function confirmedMode(response: ConversationPermissionModeResponse): ConversationPermissionMode {
  if (response?.mode === "autonomous" || response?.mode === "supervised") return response.mode
  throw new Error("Invalid conversation permission mode")
}

export function ConversationPermissionsInfo() {
  const { t } = useI18n()
  return <InfoPopoverButton label={t("permissions.info.label")}>
    <p><strong>{t("permissions.mode.autonomous")}</strong> — {t("permissions.info.autonomous")}</p>
    <p><strong>{t("permissions.mode.supervised")}</strong> — {t("permissions.info.supervised")}</p>
    <p>{t("permissions.info.scope")}</p>
  </InfoPopoverButton>
}

/** Mounted only while the captured conversation's expanded section is shown. */
export function ConversationPermissions(props: { instanceId: string; sessionId: string }) {
  const { t } = useI18n()
  const { instanceId, sessionId } = props
  const statusID = createUniqueId()
  const [mode, setMode] = createSignal<ConversationPermissionMode>()
  const [writing, setWriting] = createSignal(false)
  const [readFailed, setReadFailed] = createSignal(false)
  const [writeFailed, setWriteFailed] = createSignal(false)
  let disposed = false
  let read: AbortController | undefined
  let trailing = false
  let unconfirmed: ConversationPermissionMode | undefined

  function cancelRead() {
    read?.abort()
    read = undefined
    trailing = false
  }

  function disconnect() {
    cancelRead()
    setReadFailed(true)
  }

  async function refresh() {
    if (disposed || writing()) return // The write always reconciles afterward.
    if (read) {
      trailing = true
      return
    }
    const controller = new AbortController()
    read = controller
    try {
      const response = await serverApi.readConversationPermissionMode(instanceId, sessionId, controller.signal)
      if (read !== controller || trailing) return
      const confirmed = confirmedMode(response)
      setMode(confirmed)
      setReadFailed(false)
      if (unconfirmed) {
        setWriteFailed(confirmed !== unconfirmed)
        unconfirmed = undefined
      }
    } catch {
      if (read === controller && !trailing) {
        setReadFailed(true)
        if (unconfirmed) setWriteFailed(true)
      }
    } finally {
      if (read === controller) {
        read = undefined
        if (trailing) {
          trailing = false
          void refresh()
        }
      }
    }
  }

  onMount(() => {
    onCleanup(serverEvents.on("instance.event", (event) => {
      if (event.type !== "instance.event" || event.instanceId !== instanceId) return
      const native = event.event as { type: string; data?: { sessionID?: unknown } }
      if (native.type === "server.connected" || (native.type === "session.permissions" && native.data?.sessionID === sessionId)) void refresh()
    }))
    onCleanup(serverEvents.on("instance.eventStatus", (event) => {
      if (event.type !== "instance.eventStatus" || event.instanceId !== instanceId) return
      if (event.status === "connected") void refresh()
      else if (event.status === "disconnected" || event.status === "error") disconnect()
    }))
    onCleanup(serverEvents.onTransportStatus(status => {
      if (status === "disconnected") disconnect()
    }))
    onCleanup(serverEvents.onOpen(() => void refresh()))
    void refresh()
  })
  onCleanup(() => {
    disposed = true
    cancelRead()
  })

  async function change(select: HTMLSelectElement) {
    const next = select.value
    const previous = mode()
    select.value = previous ?? ""
    if (!previous || writing() || readFailed() || next === previous || (next !== "autonomous" && next !== "supervised")) return
    cancelRead()
    setWriting(true)
    setWriteFailed(false)
    unconfirmed = undefined
    try {
      const response = await serverApi.setConversationPermissionMode(instanceId, sessionId, next)
      if (!disposed) setMode(confirmedMode(response))
    } catch {
      if (!disposed) unconfirmed = next
    } finally {
      if (!disposed) {
        setWriting(false)
        void refresh()
      }
    }
  }

  return <div class="flex flex-col items-start gap-1">
    <Show when={mode()}>
      <select class="selector-trigger w-full min-w-0" aria-label={t("permissions.title")} aria-disabled={writing() || readFailed()}
        aria-describedby={readFailed() ? statusID : undefined}
        value={mode()} onChange={event => void change(event.currentTarget)}>
        {modes.map(value => <option value={value}>{t(`permissions.mode.${value}`)}</option>)}
      </select>
    </Show>
    <div id={statusID} role="status" class={readFailed() ? "text-xs" : "sr-only"}>{readFailed() ? t("permissions.unconfirmed")
      : writing() ? t("permissions.applying")
        : mode() ? `${t("permissions.title")}: ${t(`permissions.mode.${mode()}`)}` : ""}</div>
    <Show when={readFailed()}>
      <button class="window-action" type="button" onClick={() => void refresh()}>{t("permissions.retry")}</button>
    </Show>
    <Show when={writeFailed()}>
      <span class="text-xs" role="alert">{t("permissions.changeFailed")}</span>
    </Show>
  </div>
}
