import { createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Shield, Zap } from "lucide-solid"
import type { ConversationPermissionMode, ConversationPermissionModeResponse } from "../../../../server/src/api-types"
import { backendOf } from "../../lib/backend-client"
import { useI18n } from "../../lib/i18n"
import { HttpResponseError } from "../../lib/retryable-file-search"
import { backendEvents } from "../../lib/server-events"
import { InfoPopoverButton } from "../info-popover-button"

const modes = ["autonomous", "supervised"] as const
const modeIcons = { autonomous: Zap, supervised: Shield }

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

/** Shared by the header and body while the selected conversation's section is shown. */
export function createConversationPermissionsState(instanceId: string, sessionId: string) {
  const serverEvents = backendEvents.forInstance(() => instanceId)
  const [mode, setMode] = createSignal<ConversationPermissionMode>()
  const [writing, setWriting] = createSignal(false)
  const [readFailed, setReadFailed] = createSignal(false)
  const [writeFailed, setWriteFailed] = createSignal<"unverified" | "retry">()
  let rootSessionID: string | undefined
  let disposed = false
  let read: AbortController | undefined
  let trailing = false
  let unconfirmed: { mode: ConversationPermissionMode; error: "unverified" | "retry" } | undefined

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
      const response = await backendOf(instanceId).api.readConversationPermissionMode(instanceId, sessionId, controller.signal)
      if (read !== controller || trailing) return
      const confirmed = confirmedMode(response)
      rootSessionID = response.rootSessionID ?? sessionId
      setMode(confirmed)
      setReadFailed(false)
      if (unconfirmed) {
        setWriteFailed(confirmed !== unconfirmed.mode ? unconfirmed.error : undefined)
        unconfirmed = undefined
      }
    } catch {
      if (read === controller && !trailing) {
        setReadFailed(true)
        if (unconfirmed) setWriteFailed(unconfirmed.error)
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
      if (native.type === "server.connected" || (native.type === "session.permissions"
        && (!rootSessionID || native.data?.sessionID === rootSessionID))) void refresh()
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

  async function change(next: ConversationPermissionMode) {
    const previous = mode()
    if (!previous || writing() || readFailed() || next === previous) return
    cancelRead()
    setWriting(true)
    setWriteFailed(undefined)
    unconfirmed = undefined
    try {
      const response = await backendOf(instanceId).api.setConversationPermissionMode(instanceId, sessionId, next)
      if (!disposed) setMode(confirmedMode(response))
    } catch (error) {
      if (!disposed) unconfirmed = { mode: next,
        error: error instanceof HttpResponseError && error.code === "PERMISSION_BLOCK_UNVERIFIED" ? "unverified" : "retry" }
    } finally {
      if (!disposed) {
        setWriting(false)
        void refresh()
      }
    }
  }

  return { mode, writing, readFailed, writeFailed, refresh, change }
}

type PermissionState = ReturnType<typeof createConversationPermissionsState>

export function ConversationPermissionsSummary(props: { state: PermissionState }) {
  const { t } = useI18n()
  return <>
    <Show when={props.state.mode()}>
      {mode => (
        <span role="img" class="inline-flex align-middle" aria-label={t(`permissions.mode.${mode()}`)}>
          <Dynamic component={modeIcons[mode()]} size={14} aria-hidden="true" />
        </span>
      )}
    </Show>
    <Show when={props.state.readFailed()}><span class="ms-1 text-xs">{t("permissions.unconfirmed")}</span></Show>
  </>
}

export function ConversationPermissions(props: { state: PermissionState }) {
  const { t } = useI18n()
  const { mode, writing, readFailed, writeFailed, refresh, change } = props.state
  const statusID = createUniqueId()
  return <div class="flex flex-col items-start gap-1">
    <Show when={mode()}>
      <div role="group" aria-label={t("permissions.title")} aria-disabled={writing() || readFailed()}
        aria-describedby={readFailed() ? statusID : undefined} class="grid w-full grid-cols-2 bg-[var(--surface-control)]">
        {modes.map(value => {
          const Icon = modeIcons[value]
          return <button type="button" class="window-action icon-toggle min-w-0 min-h-[var(--control-height)] last:border-s-0" aria-pressed={mode() === value}
            onClick={() => void change(value)}>
            <Icon size={14} class="shrink-0" aria-hidden="true" />
            <span class="truncate">{t(`permissions.mode.${value}`)}</span>
          </button>
        })}
      </div>
    </Show>
    <div id={statusID} role="status" class={readFailed() ? "text-xs" : "sr-only"}>{readFailed() ? t("permissions.unconfirmed")
      : writing() ? t("permissions.applying")
        : mode() ? `${t("permissions.title")}: ${t(`permissions.mode.${mode()}`)}` : ""}</div>
    <Show when={readFailed()}>
      <button class="window-action" type="button" onClick={() => void refresh()}>{t("permissions.retry")}</button>
    </Show>
    <Show when={writeFailed()}>
      <span class="text-xs" role="alert">{t(writeFailed() === "unverified" ? "permissions.blockUnverified" : "permissions.changeFailed")}</span>
    </Show>
  </div>
}
