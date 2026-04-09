import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { Loader2, Mic, Square, Volume2 } from "lucide-solid"
import { useConfig, type SpeechSettings } from "../../stores/preferences"
import { useI18n } from "../../lib/i18n"
import { loadSpeechCapabilities, speechCapabilities, speechCapabilitiesError, speechCapabilitiesLoading } from "../../stores/speech"
import { getLogger } from "../../lib/logger"
import { useSpeech } from "../../lib/hooks/use-speech"
import { getSpeechPlaybackSupport } from "../../lib/speech-playback-support"

const log = getLogger("actions")

type DraftFields = {
  apiKey: string
  baseUrl: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  playbackMode: SpeechSettings["playbackMode"]
  ttsFormat: SpeechSettings["ttsFormat"]
}

function createDraftFields(speech: SpeechSettings): DraftFields {
  return {
    apiKey: "",
    baseUrl: speech.baseUrl ?? "",
    sttModel: speech.sttModel,
    ttsModel: speech.ttsModel,
    ttsVoice: speech.ttsVoice,
    playbackMode: speech.playbackMode,
    ttsFormat: speech.ttsFormat,
  }
}

function isDraftEqual(a: DraftFields, b: DraftFields): boolean {
  return (
    a.apiKey === b.apiKey &&
    a.baseUrl === b.baseUrl &&
    a.sttModel === b.sttModel &&
    a.ttsModel === b.ttsModel &&
    a.ttsVoice === b.ttsVoice &&
    a.playbackMode === b.playbackMode &&
    a.ttsFormat === b.ttsFormat
  )
}

export const SpeechSettingsCard: Component = () => {
  const { t } = useI18n()
  const { serverSettings, updateSpeechSettings } = useConfig()
  const initialDrafts = createDraftFields(serverSettings().speech)
  const [isSaving, setIsSaving] = createSignal(false)
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saved" | "error">("saved")
  const [drafts, setDrafts] = createSignal<DraftFields>(initialDrafts)
  const [apiKeyTouched, setApiKeyTouched] = createSignal(false)
  const [clearStoredApiKey, setClearStoredApiKey] = createSignal(false)

  const testSpeech = useSpeech({
    id: () => "settings-speech-test",
    text: () => t("settings.speech.testPlayback.sample"),
    settingsOverride: () => ({
      playbackMode: drafts().playbackMode,
      ttsFormat: drafts().ttsFormat,
    }),
  })

  createEffect(() => {
    const speech = serverSettings().speech
    const nextDrafts = createDraftFields(speech)
    if (!isSaving() && !isDirty()) {
      if (!isDraftEqual(drafts(), nextDrafts)) {
        setDrafts(nextDrafts)
      }
      if (apiKeyTouched()) {
        setApiKeyTouched(false)
      }
      if (clearStoredApiKey()) {
        setClearStoredApiKey(false)
      }
    }
  })

  createEffect(() => {
    void loadSpeechCapabilities()
  })

  const capabilityLabel = () => {
    if (speechCapabilitiesLoading()) return t("settings.speech.status.loading")
    if (speechCapabilitiesError()) return t("settings.speech.status.error")
    return speechCapabilities()?.configured ? t("settings.speech.status.configured") : t("settings.speech.status.missing")
  }

  const updateDraft = (key: keyof DraftFields, value: string) => {
    setSaveStatus("idle")
    if (key === "apiKey") {
      setApiKeyTouched(true)
      setClearStoredApiKey(false)
    }
    setDrafts((current) => ({ ...current, [key]: value }))
  }

  const apiKeyDirty = createMemo(() => clearStoredApiKey() || drafts().apiKey.trim().length > 0)
  const playbackSupport = createMemo(() =>
    getSpeechPlaybackSupport({
      playbackMode: drafts().playbackMode,
      ttsFormat: drafts().ttsFormat,
      capabilities: speechCapabilities(),
    }),
  )
  const compatibilityMessage = createMemo(() => {
    const capabilities = speechCapabilities()
    if (!capabilities?.available || !capabilities?.configured || !capabilities?.supportsTts) {
      return null
    }
    if (drafts().playbackMode === "streaming" && !capabilities.supportsStreamingTts) {
      return t("settings.speech.compatibility.streamingUnavailable")
    }
    if (drafts().playbackMode === "streaming" && !playbackSupport().available) {
      return t("settings.speech.compatibility.browserStreamingUnavailable")
    }
    return t("settings.speech.compatibility.runtimeNote")
  })

  const isDirty = createMemo(() => {
    const speech = serverSettings().speech
    const current = drafts()
    return (
      apiKeyDirty() ||
      (current.baseUrl || "") !== (speech.baseUrl || "") ||
      current.sttModel !== speech.sttModel ||
      current.ttsModel !== speech.ttsModel ||
      current.ttsVoice !== speech.ttsVoice ||
      current.playbackMode !== speech.playbackMode ||
      current.ttsFormat !== speech.ttsFormat
    )
  })

  const saveStatusLabel = () => {
    if (isSaving()) return t("settings.speech.save.saving")
    if (saveStatus() === "saved") return t("settings.speech.save.saved")
    if (saveStatus() === "error") return t("settings.speech.save.error")
    return t("settings.speech.save.unsaved")
  }

  async function handleSave() {
    if (!isDirty() || isSaving()) return
    const current = drafts()
    setIsSaving(true)
    setSaveStatus("idle")
    try {
      const trimmedApiKey = current.apiKey.trim()
      await updateSpeechSettings({
        ...(clearStoredApiKey() ? { apiKey: null } : trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
        baseUrl: current.baseUrl.trim() || undefined,
        sttModel: current.sttModel.trim() || undefined,
        ttsModel: current.ttsModel.trim() || undefined,
        ttsVoice: current.ttsVoice.trim() || undefined,
        playbackMode: current.playbackMode,
        ttsFormat: current.ttsFormat,
      })
      await loadSpeechCapabilities(true)
      setDrafts({
        apiKey: "",
        baseUrl: current.baseUrl.trim(),
        sttModel: current.sttModel.trim() || serverSettings().speech.sttModel,
        ttsModel: current.ttsModel.trim() || serverSettings().speech.ttsModel,
        ttsVoice: current.ttsVoice.trim() || serverSettings().speech.ttsVoice,
        playbackMode: current.playbackMode,
        ttsFormat: current.ttsFormat,
      })
      setApiKeyTouched(false)
      setClearStoredApiKey(false)
      setSaveStatus("saved")
    } catch (error) {
      log.error("Failed to save speech settings", error)
      setSaveStatus("error")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div class="settings-card">
      <div class="settings-card-header">
        <div class="settings-card-heading-with-icon">
          <Volume2 class="settings-card-heading-icon" />
          <div>
            <h3 class="settings-card-title">{t("settings.speech.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.speech.subtitle")}</p>
          </div>
        </div>
        <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
      </div>

      <div class="settings-stack">
        <div class="settings-toggle-row settings-toggle-row-compact">
          <div>
            <div class="settings-toggle-title">{t("settings.speech.provider.title")}</div>
            <div class="settings-toggle-caption">{t("settings.speech.provider.subtitle")}</div>
          </div>
          <div class="settings-toolbar-inline">
            <span class="settings-inline-note">{t("settings.speech.provider.openaiCompatible")}</span>
            <span class="settings-inline-note">{capabilityLabel()}</span>
            <span class="settings-inline-note">{saveStatusLabel()}</span>
            <button
              type="button"
              class="selector-button selector-button-secondary w-auto whitespace-nowrap inline-flex items-center gap-2"
              onClick={() => void testSpeech.toggle()}
              disabled={isSaving()}
              title={testSpeech.buttonTitle()}
              aria-label={testSpeech.buttonTitle()}
            >
              <Show
                when={testSpeech.isLoading()}
                fallback={
                  <Show when={testSpeech.isPlaying()} fallback={<Volume2 class="w-3.5 h-3.5" aria-hidden="true" />}>
                    <Square class="w-3.5 h-3.5" aria-hidden="true" />
                  </Show>
                }
              >
                <Loader2 class="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              </Show>
              <span>
                {testSpeech.isPlaying()
                  ? t("settings.speech.testPlayback.stop")
                  : testSpeech.isLoading()
                    ? t("settings.speech.testPlayback.generating")
                    : t("settings.speech.testPlayback.action")}
              </span>
            </button>
            <button
              type="button"
              class="selector-button selector-button-primary w-auto whitespace-nowrap"
              onClick={() => void handleSave()}
              disabled={!isDirty() || isSaving()}
            >
              {isSaving() ? t("settings.speech.save.saving") : t("settings.speech.save.action")}
            </button>
          </div>
        </div>

        <Field
          label={t("settings.speech.apiKey.title")}
          caption={t("settings.speech.apiKey.subtitle")}
          value={drafts().apiKey}
          onInput={(value) => updateDraft("apiKey", value)}
          type="password"
          placeholder={serverSettings().speech.hasApiKey ? t("settings.speech.apiKey.placeholder") : undefined}
        />
        <Show when={serverSettings().speech.hasApiKey && !apiKeyTouched() && drafts().apiKey.length === 0}>
          <div class="settings-inline-note">
            {clearStoredApiKey() ? t("settings.speech.apiKey.clearPending") : t("settings.speech.apiKey.storedNote")}{" "}
            <Show when={!clearStoredApiKey()}>
              <button
                type="button"
                class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                onClick={() => {
                  setClearStoredApiKey(true)
                  setSaveStatus("idle")
                }}
              >
                {t("settings.speech.apiKey.clearAction")}
              </button>
            </Show>
          </div>
        </Show>
        <Field
          label={t("settings.speech.baseUrl.title")}
          caption={t("settings.speech.baseUrl.subtitle")}
          value={drafts().baseUrl}
          onInput={(value) => updateDraft("baseUrl", value)}
          placeholder={t("settings.speech.baseUrl.placeholder")}
        />
        <Field
          label={t("settings.speech.sttModel.title")}
          caption={t("settings.speech.sttModel.subtitle")}
          value={drafts().sttModel}
          onInput={(value) => updateDraft("sttModel", value)}
        />
        <Field
          label={t("settings.speech.ttsModel.title")}
          caption={t("settings.speech.ttsModel.subtitle")}
          value={drafts().ttsModel}
          onInput={(value) => updateDraft("ttsModel", value)}
        />
        <Field
          label={t("settings.speech.ttsVoice.title")}
          caption={t("settings.speech.ttsVoice.subtitle")}
          value={drafts().ttsVoice}
          onInput={(value) => updateDraft("ttsVoice", value)}
          icon={<Mic class="w-3.5 h-3.5 icon-muted flex-shrink-0" />}
        />
        <SelectField
          label={t("settings.speech.playbackMode.title")}
          caption={t("settings.speech.playbackMode.subtitle")}
          value={drafts().playbackMode}
          onInput={(value) => updateDraft("playbackMode", value as DraftFields["playbackMode"])}
          options={[
            { value: "streaming", label: t("settings.speech.playbackMode.streaming") },
            { value: "buffered", label: t("settings.speech.playbackMode.buffered") },
          ]}
        />
        <SelectField
          label={t("settings.speech.ttsFormat.title")}
          caption={t("settings.speech.ttsFormat.subtitle")}
          value={drafts().ttsFormat}
          onInput={(value) => updateDraft("ttsFormat", value as DraftFields["ttsFormat"])}
          options={[
            { value: "mp3", label: "MP3" },
            { value: "wav", label: "WAV" },
            { value: "opus", label: "Opus" },
            { value: "aac", label: "AAC" },
          ]}
        />

        <div class="settings-inline-note">{t("settings.speech.help")}</div>
        <Show when={compatibilityMessage()}>{(message) => <div class="settings-inline-note">{message()}</div>}</Show>
        <div class="settings-inline-note">{t("settings.speech.testPlayback.note")}</div>
      </div>
    </div>
  )
}

const Field: Component<{
  label: string
  caption: string
  value: string
  type?: string
  placeholder?: string
  onInput: (value: string) => void
  icon?: any
}> = (props) => {
  return (
    <div class="settings-toggle-row settings-toggle-row-compact">
      <div>
        <div class="settings-toggle-title">{props.label}</div>
        <div class="settings-toggle-caption">{props.caption}</div>
      </div>
      <div class="flex items-center gap-2 w-full min-w-0 sm:min-w-[18rem] sm:max-w-[24rem]">
        {props.icon}
        <input
          type={props.type ?? "text"}
          value={props.value}
          onInput={(event) => props.onInput(event.currentTarget.value)}
          class="selector-input w-full"
          placeholder={props.placeholder}
        />
      </div>
    </div>
  )
}

const SelectField: Component<{
  label: string
  caption: string
  value: string
  onInput: (value: string) => void
  options: Array<{ value: string; label: string }>
}> = (props) => {
  return (
    <div class="settings-toggle-row settings-toggle-row-compact">
      <div>
        <div class="settings-toggle-title">{props.label}</div>
        <div class="settings-toggle-caption">{props.caption}</div>
      </div>
      <div class="w-full min-w-0 sm:min-w-[18rem] sm:max-w-[24rem]">
        <select value={props.value} onInput={(event) => props.onInput(event.currentTarget.value)} class="selector-input w-full">
          <For each={props.options}>{(option) => <option value={option.value}>{option.label}</option>}</For>
        </select>
      </div>
    </div>
  )
}

export default SpeechSettingsCard
