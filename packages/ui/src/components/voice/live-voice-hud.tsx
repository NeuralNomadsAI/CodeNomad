import { For, Show, createEffect } from "solid-js"
import { Mic, MicOff, Square, Settings, X, Radio } from "lucide-solid"
import DismissibleWindow from "../dismissible-window"
import AudioVisualizerCanvas from "./audio-visualizer-canvas"
import { useI18n } from "../../lib/i18n"
import {
  liveVoiceSession,
  type LiveVoiceProvider,
} from "../../stores/live-voice-session"

export type VoiceHudStatus = "connecting" | "listening" | "speaking" | "idle" | "error" | "disconnected"

export interface VoiceTranscriptItem {
  id: string
  speaker: "user" | "assistant"
  text: string
  timestamp?: string
  isInterim?: boolean
}

export interface LiveVoiceHudProps {
  open: boolean
  onClose: () => void
  instanceId?: string
  sessionId?: string
  status?: VoiceHudStatus
  provider?: "gemini" | "openai" | string
  availableProviders?: string[]
  onProviderChange?: (provider: string) => void
  analyserNode?: AnalyserNode | null
  transcripts?: VoiceTranscriptItem[]
  isMuted?: boolean
  onToggleMute?: () => void
  onInterrupt?: () => void
  onOpenSettings?: () => void
}

/**
 * Floating, non-modal utility window wrapping DismissibleWindow.
 * Follows strict square-corner aesthetic: zero rounded corners.
 * Uses standard .window-header, .window-title, .window-actions, .window-body, .window-footer classes.
 */
export function LiveVoiceHud(props: LiveVoiceHudProps) {
  const { t } = useI18n()
  let transcriptContainerRef: HTMLDivElement | undefined

  const resolvedStatus = (): VoiceHudStatus => {
    if (props.status) return props.status
    const state = liveVoiceSession.connectionState()
    return state === "disconnected" ? "idle" : state
  }

  const resolvedProvider = (): string => {
    return props.provider ?? liveVoiceSession.activeProvider()
  }

  const resolvedAvailableProviders = (): string[] => {
    return props.availableProviders ?? ["gemini", "openai"]
  }

  const resolvedAnalyserNode = (): AnalyserNode | null => {
    return props.analyserNode !== undefined
      ? props.analyserNode
      : liveVoiceSession.analyserNode()
  }

  const resolvedIsMuted = (): boolean => {
    return props.isMuted !== undefined ? props.isMuted : liveVoiceSession.isMuted()
  }

  const resolvedTranscripts = (): VoiceTranscriptItem[] => {
    if (props.transcripts !== undefined) {
      return props.transcripts
    }
    return liveVoiceSession.transcript().map((item) => ({
      id: item.id,
      speaker: item.role,
      text: item.text,
      timestamp: item.timestamp,
      isInterim: !item.isFinal,
    }))
  }

  const handleProviderChange = (newProvider: string) => {
    if (props.onProviderChange) {
      props.onProviderChange(newProvider)
    } else {
      liveVoiceSession.setActiveProvider(newProvider as LiveVoiceProvider)
      if (liveVoiceSession.connectionState() !== "disconnected") {
        void liveVoiceSession.connect({ provider: newProvider as LiveVoiceProvider })
      }
    }
  }

  const handleToggleMute = () => {
    if (props.onToggleMute) {
      props.onToggleMute()
    } else {
      liveVoiceSession.setMuted(!liveVoiceSession.isMuted())
    }
  }

  const handleInterrupt = () => {
    if (props.onInterrupt) {
      props.onInterrupt()
    } else {
      liveVoiceSession.interrupt()
    }
  }

  const handleClose = () => {
    if (props.status === undefined && liveVoiceSession.connectionState() !== "disconnected") {
      liveVoiceSession.disconnect()
    }
    props.onClose()
  }

  createEffect(() => {
    if (
      props.open &&
      props.status === undefined &&
      liveVoiceSession.connectionState() === "disconnected"
    ) {
      void liveVoiceSession
        .connect({
          provider: (resolvedProvider() === "openai" ? "openai" : "gemini") as LiveVoiceProvider,
        })
        .catch((err) => {
          console.error("Failed to connect live voice session:", err)
        })
    }
  })

  createEffect(() => {
    // Auto-scroll transcript container to bottom when transcript items update
    const items = resolvedTranscripts()
    const _len = items.length
    void _len
    if (transcriptContainerRef) {
      transcriptContainerRef.scrollTop = transcriptContainerRef.scrollHeight
    }
  })

  const getStatusLabel = (status: VoiceHudStatus): string => {
    switch (status) {
      case "connecting":
        return t("voice.hud.connecting") || t("voice.hud.status.connecting") || "Connecting"
      case "listening":
        return t("voice.hud.listening") || t("voice.hud.status.listening") || "Listening"
      case "speaking":
        return t("voice.hud.speaking") || t("voice.hud.status.speaking") || "Speaking"
      case "idle":
      case "disconnected":
        return t("voice.hud.idle") || t("voice.hud.status.idle") || "Idle"
      case "error":
        return t("voice.hud.error") || t("voice.hud.status.error") || "Error"
      default:
        return status
    }
  }

  const isVisualizerActive = () => {
    const status = resolvedStatus()
    return status === "listening" || status === "speaking"
  }

  return (
    <DismissibleWindow
      id="live-voice-hud-window"
      open={props.open}
      onClose={handleClose}
      title={t("voice.hud.title") || "Cockpit Live Voice"}
      description={t("voice.hud.description") || "Real-time voice assistant cockpit and transcription feed"}
      class="live-voice-hud-window"
    >
      {/* Header */}
      <div class="window-header live-voice-hud-header">
        <div class="live-voice-hud-header-left">
          <Radio class="window-leading-icon" aria-hidden="true" />
          <h2 class="window-title">{t("voice.hud.title") || "Cockpit Live Voice"}</h2>
          <span class={`live-voice-hud-status-badge ${resolvedStatus()}`}>
            {getStatusLabel(resolvedStatus())}
          </span>
          <span class="live-voice-hud-provider-tag" title={t("voice.hud.provider") || "Provider"}>
            {resolvedProvider().toUpperCase()}
          </span>
        </div>
        <div class="live-voice-hud-header-right">
          <Show when={props.onOpenSettings}>
            <button
              type="button"
              class="window-icon-button"
              onClick={props.onOpenSettings}
              aria-label={t("voice.hud.controls.settings") || "Settings"}
              title={t("voice.hud.controls.settings") || "Settings"}
            >
              <Settings class="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </Show>
          <button
            type="button"
            class="window-icon-button"
            onClick={handleClose}
            aria-label={t("voice.hud.close") || t("voice.hud.controls.close") || "Close voice mode"}
            title={t("voice.hud.close") || t("voice.hud.controls.close") || "Close voice mode"}
          >
            <X class="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Body: Audio Spectrum Canvas & Live Transcript Stream */}
      <div class="window-body live-voice-hud-body">
        {/* Spectrum visualizer */}
        <div class="live-voice-hud-visualizer-container">
          <AudioVisualizerCanvas
            analyserNode={resolvedAnalyserNode()}
            active={isVisualizerActive()}
            height={56}
          />
        </div>

        {/* Live transcript feed */}
        <div
          ref={transcriptContainerRef}
          class="live-voice-hud-transcript-feed"
          role="log"
          aria-live="polite"
        >
          <Show
            when={resolvedTranscripts().length > 0}
            fallback={
              <div class="live-voice-hud-transcript-empty">
                {t("voice.hud.empty_transcript") || t("voice.hud.transcript.empty") || "Start speaking to begin conversation..."}
              </div>
            }
          >
            <For each={resolvedTranscripts()}>
              {(entry) => (
                <div class="live-voice-hud-entry">
                  <div class="live-voice-hud-entry-meta">
                    <span class={`live-voice-hud-entry-speaker ${entry.speaker}`}>
                      {entry.speaker === "user"
                        ? t("voice.hud.transcript.user") || "You"
                        : t("voice.hud.transcript.assistant") || "Assistant"}
                    </span>
                    <Show when={entry.timestamp}>
                      <span class="live-voice-hud-entry-time">{entry.timestamp}</span>
                    </Show>
                  </div>
                  <div
                    class={`live-voice-hud-entry-text ${entry.isInterim ? "interim" : ""}`}
                  >
                    {entry.text}
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>

      {/* Footer: Controls */}
      <div class="window-footer live-voice-hud-footer">
        <Show when={resolvedAvailableProviders().length > 1}>
          <select
            class="live-voice-hud-select"
            value={resolvedProvider()}
            onChange={(e) => handleProviderChange(e.currentTarget.value)}
            aria-label={t("voice.hud.switch_provider") || t("voice.hud.provider") || "Switch Voice Provider"}
            title={t("voice.hud.switch_provider") || t("voice.hud.provider") || "Switch Voice Provider"}
          >
            <For each={resolvedAvailableProviders()}>
              {(prov) => (
                <option value={prov}>
                  {prov.toUpperCase()}
                </option>
              )}
            </For>
          </select>
        </Show>

        <div class="live-voice-hud-footer-actions">
          <button
            type="button"
            class="window-action"
            onClick={handleInterrupt}
            disabled={resolvedStatus() !== "speaking"}
            title={t("voice.hud.interrupt") || t("voice.hud.controls.interrupt") || "Interrupt response"}
          >
            <Square class="w-3 h-3 text-red-500 fill-current" aria-hidden="true" />
            <span>{t("voice.hud.interrupt") || t("voice.hud.controls.interrupt") || "Interrupt"}</span>
          </button>

          <button
            type="button"
            class="window-action"
            onClick={handleToggleMute}
            aria-pressed={Boolean(resolvedIsMuted())}
            title={
              resolvedIsMuted()
                ? t("voice.hud.unmute") || t("voice.hud.controls.unmute") || "Unmute microphone"
                : t("voice.hud.mute") || t("voice.hud.controls.mute") || "Mute microphone"
            }
          >
            <Show
              when={resolvedIsMuted()}
              fallback={<Mic class="w-3 h-3" aria-hidden="true" />}
            >
              <MicOff class="w-3 h-3 text-red-500" aria-hidden="true" />
            </Show>
            <span>
              {resolvedIsMuted()
                ? t("voice.hud.unmute") || t("voice.hud.controls.unmute") || "Unmute"
                : t("voice.hud.mute") || t("voice.hud.controls.mute") || "Mute"}
            </span>
          </button>
        </div>
      </div>
    </DismissibleWindow>
  )
}
export default LiveVoiceHud
