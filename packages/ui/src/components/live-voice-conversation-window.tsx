import { Dialog } from "@kobalte/core/dialog"
import { Mic, MicOff, Settings, VolumeX } from "lucide-solid"
import { For, Show, createEffect, createMemo, createRenderEffect, onCleanup, untrack } from "solid-js"
import type { LiveVoiceUnavailable, useLiveVoiceConversation } from "../lib/hooks/use-live-voice-conversation"
import { useI18n } from "../lib/i18n"
import type { LiveVoiceStopReason, LiveVoiceTranscriptRow } from "../lib/live-voice-session"
import { openSettingsRow } from "../stores/settings-screen"
import DismissibleWindow from "./dismissible-window"
import WindowCloseButton from "./window-close-button"

export const LIVE_VOICE_CONVERSATION_WINDOW_ID = "live-voice-conversation"

// Isolate interpolated names in both LTR and RTL locales.
const isolate = (text: string) => `\u2068${text}\u2069`

function endStatusKey(reason: LiveVoiceStopReason) {
  switch (reason) {
    case "stopped":
    case "idle":
    case "duration":
    case "permission":
    case "busy":
    case "unconfigured":
    case "device":
      return `voice.live.status.${reason}`
    case "connection":
    case "setup-timeout":
    case "provider-disconnected":
      return "voice.live.status.connection"
    case "dictation":
    case "test":
    case "conversation":
      return `voice.microphone.${reason}`
    case "microphoneUnavailable":
      return "voice.microphone.unavailable"
    default:
      return "voice.live.status.error"
  }
}

export default function LiveVoiceConversationWindow(props: {
  controller: ReturnType<typeof useLiveVoiceConversation>
  targetLabel: string
  returnFocus: () => HTMLElement | undefined
}) {
  const { t } = useI18n()
  const state = () => props.controller.state()
  const gemini = () => {
    const current = state()
    return current.phase !== "closed" && current.engine === "gemini-live"
  }
  const provider = () => isolate(t(gemini() ? "voice.live.provider.gemini" : "voice.live.provider.openai"))
  const company = () => isolate(gemini() ? "Google" : "OpenAI")
  const title = () => t("voice.live.title", { provider: provider() })
  const interruptLabel = () => t(gemini() ? "voice.live.stopPlayback" : "voice.live.interrupt")
  const active = () => state().phase === "starting" || state().phase === "live"
  const statusKey = createMemo(() => {
    const current = state()
    if (current.phase === "ended") return endStatusKey(current.reason)
    if (current.phase !== "live") return "voice.live.status.connecting"
    if (props.controller.muted()) return "voice.live.status.muted"
    return `voice.live.status.${props.controller.activity()}`
  })
  const failed = () => {
    const current = state()
    return current.phase === "ended" && !["stopped", "idle", "duration"].includes(current.reason)
  }
  const dismiss = () => props.controller.dismiss()
  let close: HTMLButtonElement | undefined
  let microphone: HTMLButtonElement | undefined
  createRenderEffect(() => {
    const current = state()
    if (current.phase === "ended" && document.activeElement === microphone) {
      untrack(() => close?.focus({ preventScroll: true }))
    }
  })

  return <>
    <Show when={state().phase === "consent"}>
      <LiveVoiceConsent provider={provider()} company={company()} targetLabel={props.targetLabel}
        unavailable={props.controller.unavailable()}
        accept={() => props.controller.acceptConsent()} cancel={dismiss}
        returnFocus={() => state().phase === "closed" ? props.returnFocus() : undefined} />
    </Show>
    <DismissibleWindow id={LIVE_VOICE_CONVERSATION_WINDOW_ID} open={active() || state().phase === "ended"}
      class="live-voice-conversation" draggable title={title()} onClose={dismiss}
      returnFocus={props.returnFocus} initialFocus={() => {
        const focused = document.activeElement
        return focused instanceof HTMLElement && focused.closest(".interruption-dock") ? focused : close
      }}>
      <header class="window-header" data-window-drag-handle>
        <h2 class="window-title min-w-0 flex-1">{title()}</h2>
        <button type="button" class="window-action" aria-disabled={!active()}
          onClick={() => { if (active()) props.controller.stop() }}>
          {t("voice.live.stop")}
        </button>
        <WindowCloseButton ref={element => { close = element }} onClose={dismiss} />
      </header>
      <div class="window-toolbar live-voice-toolbar">
        <VoiceTarget label={props.targetLabel} />
        <div class="live-voice-state" data-error={failed() ? "" : undefined}>
          <Show when={state().phase === "live" && !props.controller.muted()}>
            <VoiceActivity read={props.controller.activityLevel} />
          </Show>
          <span role="status" aria-atomic="true">{t(statusKey())}</span>
        </div>
        <div class="live-voice-actions">
          <button ref={element => { microphone = element }} type="button" class="window-icon-button icon-toggle"
            aria-label={t("voice.live.mute")} title={t("voice.live.mute")}
            aria-pressed={props.controller.muted()} disabled={state().phase !== "live"}
            onClick={props.controller.toggleMute}>
            <Show when={props.controller.muted()} fallback={<Mic aria-hidden="true" />}>
              <MicOff aria-hidden="true" />
            </Show>
          </button>
          <button type="button" class="window-icon-button"
            aria-label={interruptLabel()} title={interruptLabel()}
            aria-disabled={!props.controller.canInterrupt()}
            onClick={() => { if (props.controller.canInterrupt()) props.controller.interrupt() }}>
            <VolumeX aria-hidden="true" />
          </button>
          <button type="button" class="window-icon-button"
            aria-label={t("voice.live.settings")} title={t("voice.live.settings")}
            onClick={() => void openSettingsRow("speech", "voice-conversation")}>
            <Settings aria-hidden="true" />
          </button>
        </div>
      </div>
      <VoiceTranscript rows={props.controller.transcript} />
    </DismissibleWindow>
  </>
}

function VoiceTarget(props: { label: string }) {
  const { t } = useI18n()
  return <div class="live-voice-target">
    <span>{t("voice.live.target")}</span>
    <bdi title={props.label}>{props.label}</bdi>
  </div>
}

function LiveVoiceConsent(props: {
  provider: string
  company: string
  targetLabel: string
  unavailable?: LiveVoiceUnavailable
  accept: () => void
  cancel: () => void
  returnFocus: () => HTMLElement | undefined
}) {
  const { t } = useI18n()
  const unavailableKey = () => {
    const reason = props.unavailable
    if (reason === "missingKey") return "voice.live.status.unconfigured"
    return reason ? `voice.command.${reason}` as const : undefined
  }
  let cancel: HTMLButtonElement | undefined
  return <Dialog open modal onOpenChange={open => { if (!open) props.cancel() }}>
    <Dialog.Portal>
      <Dialog.Overlay class="modal-overlay z-[60]" />
      <Dialog.Content class="modal-surface window-shell alert-dialog live-voice-consent"
        onEscapeKeyDown={event => {
          event.preventDefault()
          event.stopImmediatePropagation()
          props.cancel()
        }}
        onOpenAutoFocus={event => {
          if (!cancel) return
          event.preventDefault()
          untrack(() => cancel?.focus({ preventScroll: true }))
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          const active = document.activeElement
          if (active?.isConnected && active !== document.body && active !== cancel) return
          const target = props.returnFocus()
          if (target?.getClientRects().length) untrack(() => target.focus({ preventScroll: true }))
        }}>
        <header class="window-header">
          <Dialog.Title class="window-title">{t("voice.live.consent.title", { provider: props.provider })}</Dialog.Title>
        </header>
        <Dialog.Description as="div" class="window-body live-voice-consent-copy">
          <VoiceTarget label={props.targetLabel} />
          <p>{t("voice.live.consent.audio", { provider: props.provider, company: props.company })}</p>
          <p>{t("voice.live.consent.text")}</p>
          <p>{t("voice.live.consent.send")}</p>
          <p>{t("voice.live.consent.billing", { company: props.company })}</p>
          <Show when={unavailableKey()}>{key => <p role="status">{t(key())}</p>}</Show>
        </Dialog.Description>
        <footer class="window-footer">
          <button ref={element => { cancel = element }} type="button" class="button-secondary" onClick={props.cancel}>
            {t("alertDialog.actions.cancel")}
          </button>
          <button type="button" class="button-primary" onClick={() => {
            if (props.unavailable) {
              props.cancel()
              void openSettingsRow("speech", "voice-conversation")
            } else props.accept()
          }}>
            {t(props.unavailable ? "voice.live.settings" : "voice.live.consent.start")}
          </button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog>
}

function VoiceTranscript(props: { rows: () => readonly LiveVoiceTranscriptRow[] }) {
  const { t } = useI18n()
  const byId = createMemo(() => new Map(props.rows().map(row => [row.id, row])))
  let body!: HTMLDivElement
  let follow = true
  createEffect(() => {
    byId()
    if (!follow) return
    const frame = requestAnimationFrame(() => { if (follow) body.scrollTop = body.scrollHeight })
    onCleanup(() => cancelAnimationFrame(frame))
  })
  const role = (row: LiveVoiceTranscriptRow) => t(`voice.live.transcript.${row.role}`)
  return <>
    <div class="window-body live-voice-transcript" tabIndex={0} role="region" aria-label={t("voice.live.transcript.label")}
      ref={body} onScroll={() => { follow = body.scrollHeight - body.clientHeight - body.scrollTop <= 12 }}>
      <ol role="list" class="live-voice-transcript-list">
        <For each={[...byId().keys()]}>{id =>
          <Show when={byId().get(id)}>{row => <li data-role={row().role}>
            <span class="live-voice-transcript-role">{role(row())}</span>
            <Show when={row().text}>{text => <p dir="auto">{text()}</p>}</Show>
          </li>}</Show>
        }</For>
      </ol>
    </div>
    <div class="sr-only" role="log" aria-label={t("voice.live.transcript.label")} aria-relevant="additions">
      <For each={props.rows().filter(row => row.announce).map(row => row.id)}>{id => {
        const row = byId().get(id)!
        return <div>{row.role === "sent" || row.role === "interrupted" ? role(row) : `${role(row)}: ${isolate(row.text)}`}</div>
      }}</For>
    </div>
  </>
}

function VoiceActivity(props: { read: () => number }) {
  let meter!: HTMLSpanElement
  createEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
    let frame = 0
    const tick = () => {
      meter.style.setProperty("--live-voice-level", String(Math.min(1, Math.max(0, props.read() || 0))))
      frame = requestAnimationFrame(tick)
    }
    const sync = () => {
      cancelAnimationFrame(frame)
      if (!reduced.matches) frame = requestAnimationFrame(tick)
    }
    sync()
    reduced.addEventListener("change", sync)
    onCleanup(() => {
      reduced.removeEventListener("change", sync)
      cancelAnimationFrame(frame)
    })
  })
  return <span ref={meter} class="live-voice-meter" aria-hidden="true"><i /><i /><i /><i /><i /></span>
}
