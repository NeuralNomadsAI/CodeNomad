import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { Loader2, Mic, Square, Volume2 } from "lucide-solid"
import { useConfig, type SpeechSettings } from "../../stores/preferences"
import { useI18n } from "../../lib/i18n"
import { loadSpeechCapabilities, speechCapabilities, speechCapabilitiesError, speechCapabilitiesLoading } from "../../stores/speech"
import { getLogger } from "../../lib/logger"
import { useSpeech } from "../../lib/hooks/use-speech"
import { useTranscriptionTest } from "../../lib/hooks/use-transcription-test"
import { getSpeechPlaybackSupport } from "../../lib/speech-playback-support"

const log = getLogger("actions")

type DirectionalDraft = {
  apiKey: string
  baseUrl: string
  model: string
}

type DraftFields = {
  separateProviders: boolean
  apiKey: string
  baseUrl: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  playbackMode: SpeechSettings["playbackMode"]
  ttsFormat: SpeechSettings["ttsFormat"]
  stt: DirectionalDraft
  tts: DirectionalDraft
}

function createDirectionalDraft(speech: SpeechSettings, direction: "stt" | "tts"): DirectionalDraft {
  const dir = speech[direction]
  return {
    apiKey: "",
    baseUrl: dir.baseUrl ?? "",
    model: dir.model || (direction === "stt" ? speech.sttModel : speech.ttsModel),
  }
}

function createDraftFields(speech: SpeechSettings): DraftFields {
  return {
    separateProviders: speech.separateProviders,
    apiKey: "",
    baseUrl: speech.baseUrl ?? "",
    sttModel: speech.sttModel,
    ttsModel: speech.ttsModel,
    ttsVoice: speech.ttsVoice,
    playbackMode: speech.playbackMode,
    ttsFormat: speech.ttsFormat,
    stt: createDirectionalDraft(speech, "stt"),
    tts: createDirectionalDraft(speech, "tts"),
  }
}

function isDirectionalDraftEqual(a: DirectionalDraft, b: DirectionalDraft): boolean {
  return (
    a.apiKey === b.apiKey &&
    a.baseUrl === b.baseUrl &&
    a.model === b.model
  )
}

function isDraftEqual(a: DraftFields, b: DraftFields): boolean {
  return (
    a.separateProviders === b.separateProviders &&
    a.apiKey === b.apiKey &&
    a.baseUrl === b.baseUrl &&
    a.sttModel === b.sttModel &&
    a.ttsModel === b.ttsModel &&
    a.ttsVoice === b.ttsVoice &&
    a.playbackMode === b.playbackMode &&
    a.ttsFormat === b.ttsFormat &&
    isDirectionalDraftEqual(a.stt, b.stt) &&
    isDirectionalDraftEqual(a.tts, b.tts)
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
  const [sttApiKeyTouched, setSttApiKeyTouched] = createSignal(false)
  const [clearSttApiKey, setClearSttApiKey] = createSignal(false)
  const [ttsApiKeyTouched, setTtsApiKeyTouched] = createSignal(false)
  const [clearTtsApiKey, setClearTtsApiKey] = createSignal(false)

  const testSpeech = useSpeech({
    id: () => "settings-speech-test",
    text: () => t("settings.speech.testPlayback.sample"),
    settingsOverride: () => ({
      playbackMode: drafts().playbackMode,
      ttsFormat: drafts().ttsFormat,
    }),
  })

  const testTranscription = useTranscriptionTest()

  createEffect(() => {
    const speech = serverSettings().speech
    const nextDrafts = createDraftFields(speech)
    if (!isSaving() && !isDirty()) {
      if (!isDraftEqual(drafts(), nextDrafts)) {
        setDrafts(nextDrafts)
      }
      if (apiKeyTouched()) setApiKeyTouched(false)
      if (clearStoredApiKey()) setClearStoredApiKey(false)
      if (sttApiKeyTouched()) setSttApiKeyTouched(false)
      if (clearSttApiKey()) setClearSttApiKey(false)
      if (ttsApiKeyTouched()) setTtsApiKeyTouched(false)
      if (clearTtsApiKey()) setClearTtsApiKey(false)
    }
  })

  createEffect(() => {
    void loadSpeechCapabilities()
  })

  const capabilityLabel = () => {
    if (speechCapabilitiesLoading()) return t("settings.speech.status.loading")
    if (speechCapabilitiesError()) return t("settings.speech.status.error")
    const caps = speechCapabilities()
    if (caps?.separateProviders) {
      if (caps.sttConfigured && caps.ttsConfigured) return t("settings.speech.status.configured")
      if (caps.sttConfigured || caps.ttsConfigured) return t("settings.speech.status.partial")
      return t("settings.speech.status.missing")
    }
    return caps?.configured ? t("settings.speech.status.configured") : t("settings.speech.status.missing")
  }

  const updateDraft = (key: keyof DraftFields, value: string) => {
    setSaveStatus("idle")
    if (key === "apiKey") {
      setApiKeyTouched(true)
      setClearStoredApiKey(false)
    }
    setDrafts((current) => ({ ...current, [key]: value }))
  }

  const updateDirectionalDraft = (dir: "stt" | "tts", key: keyof DirectionalDraft, value: string) => {
    setSaveStatus("idle")
    if (key === "apiKey") {
      if (dir === "stt") {
        setSttApiKeyTouched(true)
        setClearSttApiKey(false)
      } else {
        setTtsApiKeyTouched(true)
        setClearTtsApiKey(false)
      }
    }
    setDrafts((current) => ({
      ...current,
      [dir]: { ...current[dir], [key]: value },
    }))
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
    if (!capabilities?.available || !capabilities?.ttsConfigured || !capabilities?.supportsTts) {
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

    if (current.separateProviders !== speech.separateProviders) return true

    if (current.separateProviders) {
      const sttDir = speech.stt
      const ttsDir = speech.tts
      const sttDirty =
        clearSttApiKey() ||
        current.stt.apiKey.trim().length > 0 ||
        (current.stt.baseUrl || "") !== (sttDir.baseUrl || "") ||
        current.stt.model !== sttDir.model
      const ttsDirty =
        clearTtsApiKey() ||
        current.tts.apiKey.trim().length > 0 ||
        (current.tts.baseUrl || "") !== (ttsDir.baseUrl || "") ||
        current.tts.model !== ttsDir.model ||
        current.ttsVoice !== speech.ttsVoice ||
        current.playbackMode !== speech.playbackMode ||
        current.ttsFormat !== speech.ttsFormat
      return sttDirty || ttsDirty
    }

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
      const saved = serverSettings().speech
      if (current.separateProviders) {
        const buildDirSave = (
          clearKey: boolean,
          draftApiKey: string,
          draftBaseUrl: string,
          draftModel: string,
          storedDir: { hasApiKey: boolean; baseUrl?: string; model: string },
          sharedModel: string,
        ): { apiKey?: string | null; baseUrl?: string | null; model?: string | null } => {
          if (clearKey) return { apiKey: null, baseUrl: null, model: null }
          const newKey = draftApiKey.trim()
          const baseUrlChanged = (draftBaseUrl.trim() || "") !== (storedDir.baseUrl || "")
          const modelMatchesShared = draftModel.trim() === sharedModel.trim()
          return {
            ...(newKey ? { apiKey: newKey } : baseUrlChanged && storedDir.hasApiKey ? { apiKey: null } : {}),
            baseUrl: draftBaseUrl.trim() || null,
            model: modelMatchesShared ? null : (draftModel.trim() || null),
          }
        }
        await updateSpeechSettings({
          separateProviders: true,
          stt: buildDirSave(clearSttApiKey(), current.stt.apiKey, current.stt.baseUrl, current.stt.model, saved.stt, saved.sttModel),
          tts: buildDirSave(clearTtsApiKey(), current.tts.apiKey, current.tts.baseUrl, current.tts.model, saved.tts, saved.ttsModel),
          ttsVoice: current.ttsVoice.trim() || null,
          playbackMode: current.playbackMode,
          ttsFormat: current.ttsFormat,
        })
      } else {
        const trimmedApiKey = current.apiKey.trim()
        await updateSpeechSettings({
          separateProviders: false,
          ...(clearStoredApiKey() ? { apiKey: null } : trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
          baseUrl: current.baseUrl.trim() || null,
          sttModel: current.sttModel.trim() || null,
          ttsModel: current.ttsModel.trim() || null,
          ttsVoice: current.ttsVoice.trim() || null,
          playbackMode: current.playbackMode,
          ttsFormat: current.ttsFormat,
        })
      }
      await loadSpeechCapabilities(true)
      setDrafts(createDraftFields(serverSettings().speech))
      setApiKeyTouched(false)
      setClearStoredApiKey(false)
      setSttApiKeyTouched(false)
      setClearSttApiKey(false)
      setTtsApiKeyTouched(false)
      setClearTtsApiKey(false)
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
              onClick={() => void testTranscription.toggle()}
              disabled={isSaving() || testTranscription.state() === "requesting" || testTranscription.state() === "transcribing" || (testTranscription.state() === "idle" && !testTranscription.canUseTranscription())}
              title={testTranscription.buttonTitle()}
              aria-label={testTranscription.buttonTitle()}
            >
              <Show
                when={testTranscription.isTranscribing() || testTranscription.state() === "requesting"}
                fallback={
                  <Show
                    when={testTranscription.isRecording()}
                    fallback={<Mic class="w-3.5 h-3.5" aria-hidden="true" />}
                  >
                    <Square class="w-3.5 h-3.5" aria-hidden="true" />
                  </Show>
                }
              >
                <Loader2 class="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              </Show>
              <span>
                {testTranscription.buttonTitle()}
              </span>
            </button>
            <Show when={testTranscription.result()}>
              {(text) => (
                <span class="settings-inline-note" title={text()}>
                  {text().length > 40 ? `${text().slice(0, 40)}…` : text()}
                </span>
              )}
            </Show>
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

        <div class="settings-toggle-row settings-toggle-row-compact">
          <div>
            <div class="settings-toggle-title">{t("settings.speech.separateProviders.title")}</div>
            <div class="settings-toggle-caption">{t("settings.speech.separateProviders.subtitle")}</div>
          </div>
          <label class="settings-checkbox-toggle">
            <input
              type="checkbox"
              checked={drafts().separateProviders}
              onChange={(event) => {
                if (isSaving()) return
                setSaveStatus("idle")
                setDrafts((current) => ({ ...current, separateProviders: event.currentTarget.checked }))
              }}
            />
            <span>{t("settings.common.enabled")}</span>
          </label>
        </div>

        <Show when={!drafts().separateProviders}>
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
                  onClick={() => { setClearStoredApiKey(true); setSaveStatus("idle") }}
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
        </Show>

        <Show when={drafts().separateProviders}>
          <div class="settings-card-section-header">
            <h4 class="settings-card-section-title">{t("settings.speech.stt.section.title")}</h4>
          </div>
          <Field
            label={t("settings.speech.stt.apiKey.title")}
            caption={t("settings.speech.stt.apiKey.subtitle")}
            value={drafts().stt.apiKey}
            onInput={(value) => updateDirectionalDraft("stt", "apiKey", value)}
            type="password"
            placeholder={(serverSettings().speech.stt.hasApiKey || serverSettings().speech.hasApiKey) ? t("settings.speech.stt.apiKey.placeholder") : undefined}
          />
          <Show when={(serverSettings().speech.stt.hasApiKey || serverSettings().speech.hasApiKey) && !sttApiKeyTouched() && drafts().stt.apiKey.length === 0}>
            <div class="settings-inline-note">
              <Show
                when={serverSettings().speech.stt.hasApiKey}
                fallback={t("settings.speech.stt.apiKey.usingShared")}
              >
                {clearSttApiKey() ? t("settings.speech.stt.apiKey.clearPending") : t("settings.speech.stt.apiKey.storedNote")}{" "}
                <Show when={!clearSttApiKey()}>
                  <button
                    type="button"
                    class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                    onClick={() => { setClearSttApiKey(true); setSaveStatus("idle") }}
                  >
                    {t("settings.speech.stt.apiKey.clearAction")}
                  </button>
                </Show>
              </Show>
            </div>
          </Show>
          <Field
            label={t("settings.speech.stt.baseUrl.title")}
            caption={t("settings.speech.stt.baseUrl.subtitle")}
            value={drafts().stt.baseUrl}
            onInput={(value) => updateDirectionalDraft("stt", "baseUrl", value)}
            placeholder={t("settings.speech.stt.baseUrl.placeholder")}
          />
          <Field
            label={t("settings.speech.stt.model.title")}
            caption={t("settings.speech.stt.model.subtitle")}
            value={drafts().stt.model}
            onInput={(value) => updateDirectionalDraft("stt", "model", value)}
          />

          <div class="settings-card-section-header">
            <h4 class="settings-card-section-title">{t("settings.speech.tts.section.title")}</h4>
          </div>
          <Field
            label={t("settings.speech.tts.apiKey.title")}
            caption={t("settings.speech.tts.apiKey.subtitle")}
            value={drafts().tts.apiKey}
            onInput={(value) => updateDirectionalDraft("tts", "apiKey", value)}
            type="password"
            placeholder={(serverSettings().speech.tts.hasApiKey || serverSettings().speech.hasApiKey) ? t("settings.speech.tts.apiKey.placeholder") : undefined}
          />
          <Show when={(serverSettings().speech.tts.hasApiKey || serverSettings().speech.hasApiKey) && !ttsApiKeyTouched() && drafts().tts.apiKey.length === 0}>
            <div class="settings-inline-note">
              <Show
                when={serverSettings().speech.tts.hasApiKey}
                fallback={t("settings.speech.tts.apiKey.usingShared")}
              >
                {clearTtsApiKey() ? t("settings.speech.tts.apiKey.clearPending") : t("settings.speech.tts.apiKey.storedNote")}{" "}
                <Show when={!clearTtsApiKey()}>
                  <button
                    type="button"
                    class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                    onClick={() => { setClearTtsApiKey(true); setSaveStatus("idle") }}
                  >
                    {t("settings.speech.tts.apiKey.clearAction")}
                  </button>
                </Show>
              </Show>
            </div>
          </Show>
          <Field
            label={t("settings.speech.tts.baseUrl.title")}
            caption={t("settings.speech.tts.baseUrl.subtitle")}
            value={drafts().tts.baseUrl}
            onInput={(value) => updateDirectionalDraft("tts", "baseUrl", value)}
            placeholder={t("settings.speech.tts.baseUrl.placeholder")}
          />
          <Field
            label={t("settings.speech.tts.model.title")}
            caption={t("settings.speech.tts.model.subtitle")}
            value={drafts().tts.model}
            onInput={(value) => updateDirectionalDraft("tts", "model", value)}
          />
          <Field
            label={t("settings.speech.ttsVoice.title")}
            caption={t("settings.speech.ttsVoice.subtitle")}
            value={drafts().ttsVoice}
            onInput={(value) => updateDraft("ttsVoice", value)}
            icon={<Mic class="w-3.5 h-3.5 icon-muted flex-shrink-0" />}
          />
        </Show>
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
