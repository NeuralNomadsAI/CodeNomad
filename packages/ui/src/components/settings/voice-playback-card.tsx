import { Show, createMemo, createSignal } from "solid-js"
import { Loader2, Square, Volume2 } from "lucide-solid"
import { useSpeech } from "../../lib/hooks/use-speech"
import { useI18n } from "../../lib/i18n"
import { getSpeechPlaybackSupport } from "../../lib/speech-playback-support"
import { useConfig, type SpeechSettings, type SpeechSettingsUpdate } from "../../stores/preferences"
import { loadSpeechCapabilities, speechCapabilities, speechCapabilitiesError } from "../../stores/speech"
import { SettingsInfoTip } from "./settings-info-tip"
import { VoiceManualCredentials } from "./voice-manual-credentials"
import { VoiceSave, VoiceSelectField, VoiceSettingsCard, VoiceTextField } from "./voice-settings-fields"

type Playback = Pick<SpeechSettings, "playbackMode" | "ttsFormat" | "ttsVoice">
const formats = [
  { value: "mp3", label: "MP3" },
  { value: "wav", label: "WAV" },
  { value: "opus", label: "Opus" },
  { value: "aac", label: "AAC" },
] as const

export function VoicePlaybackCard(props: {
  credentialsOpen: boolean
  setCredentialsOpen: (value: boolean) => void
  settled: boolean
}) {
  const { t } = useI18n()
  const config = useConfig()
  const [draft, setDraft] = createSignal<Partial<Playback>>({})
  const [saving, setSaving] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const saved = () => config.serverSettings().speech
  const caps = speechCapabilities
  const mode = () => draft().playbackMode ?? saved().playbackMode
  const format = () => draft().ttsFormat ?? saved().ttsFormat
  const savedVoice = () => caps()?.ttsVoice ?? saved().ttsVoice
  const voice = () => draft().ttsVoice ?? savedVoice()
  const test = useSpeech({
    id: () => "settings-speech-test",
    text: () => t("settings.speech.testPlayback.sample"),
    settingsOverride: () => ({ playbackMode: mode(), ttsFormat: format() }),
  })
  const edit = (patch: Partial<Playback>) => {
    setFailed(false)
    setDraft(current => ({ ...current, ...patch }))
  }
  const patch = createMemo<SpeechSettingsUpdate>(() => ({
    ...(mode() !== saved().playbackMode ? { playbackMode: mode() } : {}),
    ...(format() !== saved().ttsFormat ? { ttsFormat: format() } : {}),
    ...(voice().trim() !== savedVoice() ? { ttsVoice: voice().trim() || null } : {}),
  }))
  const dirty = () => Object.keys(patch()).length > 0
  const provider = () => {
    const capability = caps()
    if (!capability?.available) return t("settings.voice.unavailable")
    const baseUrl = capability.separateProviders ? capability.ttsBaseUrl : capability.baseUrl
    if (baseUrl) {
      try { return new URL(baseUrl).host || t("settings.voice.playback.openaiCompatible") } catch { /* Show the provider name. */ }
    }
    return capability.provider === "openai-compatible" ? t("settings.voice.playback.openaiCompatible") : capability.provider
  }
  const compatibility = () => {
    if (!caps()?.available || !caps()?.ttsConfigured || !caps()?.supportsTts) return
    const support = getSpeechPlaybackSupport({ playbackMode: mode(), ttsFormat: format(), capabilities: caps() })
    if (support.reason === "provider-streaming-unavailable") return t("settings.speech.compatibility.streamingUnavailable")
    if (support.reason === "browser-streaming-unavailable") return t("settings.speech.compatibility.browserStreamingUnavailable")
  }
  const status = () => {
    if (speechCapabilitiesError()) return t("settings.speech.status.error")
    const capability = caps()
    if (!capability || !config.isLoaded()) return t("settings.speech.status.loading")
    if (!capability.available || !capability.supportsTts) return t("settings.voice.unavailable")
    if (!capability.ttsConfigured) return t("settings.voice.notConfigured")
    const support = getSpeechPlaybackSupport({ playbackMode: saved().playbackMode, ttsFormat: saved().ttsFormat, capabilities: capability })
    if (support.available) return t("settings.speech.status.configured")
    return t(support.reason === "unsupported-environment" ? "settings.voice.unavailable" : "voice.command.unsupportedFormat")
  }
  async function save() {
    if (!dirty() || saving() || !config.isLoaded()) return
    setSaving(true)
    setFailed(false)
    try {
      await config.updateSpeechSettings(patch())
      await loadSpeechCapabilities(true)
      setDraft({})
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <VoiceSettingsCard id="voice-playback" title={t("settings.voice.playback.title")} status={status()}
      settled={props.settled && config.isLoaded() && Boolean(caps() || speechCapabilitiesError())}>
      <div class="settings-toggle-row settings-toggle-row-compact">
        <span class="settings-toggle-title">{t("settings.speech.provider.title")}</span>
        <span class="settings-inline-note min-w-0 break-words">{provider()}</span>
      </div>
      <form class="settings-stack" onSubmit={event => { event.preventDefault(); void save() }}>
        <VoiceSelectField
          label={t("settings.speech.playbackMode.title")}
          info={t("settings.speech.playbackMode.subtitle")}
          value={mode()} onChange={playbackMode => edit({ playbackMode })} disabled={saving()}
          options={[
            { value: "streaming", label: t("settings.speech.playbackMode.streaming") },
            { value: "buffered", label: t("settings.speech.playbackMode.buffered") },
          ]}
        />
        <VoiceTextField label={t("settings.speech.ttsVoice.title")} value={voice()}
          onInput={ttsVoice => edit({ ttsVoice })} disabled={saving()} />
        <VoiceSelectField label={t("settings.speech.ttsFormat.title")} value={format()}
          onChange={ttsFormat => edit({ ttsFormat })} disabled={saving()} options={formats} />
        <Show when={compatibility()}>{message => <div class="settings-inline-note" role="status">{message()}</div>}</Show>
        <div class="settings-toolbar-inline flex-wrap">
          <button
            type="button"
            class="selector-button selector-button-secondary w-auto inline-flex items-center gap-2"
            onClick={() => void test.toggle()}
            disabled={test.state() === "idle" && (saving() || !test.canUseSpeech())}
          >
            <Show when={test.isLoading()} fallback={
              <Show when={test.isPlaying()} fallback={<Volume2 class="size-3.5" aria-hidden="true" />}>
                <Square class="size-3.5" aria-hidden="true" />
              </Show>
            }>
              <span class="inline-flex animate-spin"><Loader2 class="size-3.5" aria-hidden="true" /></span>
            </Show>
            {t(test.isPlaying() ? "settings.speech.testPlayback.stop"
              : test.isLoading() ? "settings.speech.testPlayback.generating" : "settings.speech.testPlayback.action")}
          </button>
          <SettingsInfoTip text={t("settings.speech.testPlayback.note")} help={{ page: "voice", anchor: "test" }} />
          <VoiceSave dirty={dirty() && config.isLoaded()} saving={saving()} error={failed() ? t("settings.speech.save.error") : undefined} />
        </div>
      </form>
      <details class="settings-disclosure mt-3" open={props.credentialsOpen}
        onToggle={event => props.setCredentialsOpen(event.currentTarget.open)}>
        <summary><h4>{t("settings.voice.credentials.title")}</h4></summary>
        <VoiceManualCredentials />
      </details>
    </VoiceSettingsCard>
  )
}
