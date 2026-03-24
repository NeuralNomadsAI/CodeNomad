import { createEffect, createMemo, createSignal, type Component } from "solid-js"
import { Mic, Volume2 } from "lucide-solid"
import { useConfig, type SpeechSettings } from "../../stores/preferences"
import { useI18n } from "../../lib/i18n"
import { loadSpeechCapabilities, speechCapabilities, speechCapabilitiesError, speechCapabilitiesLoading } from "../../stores/speech"
import { getLogger } from "../../lib/logger"

const log = getLogger("actions")

type DraftFields = {
  apiKey: string
  baseUrl: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
}

function createDraftFields(speech: SpeechSettings): DraftFields {
  return {
    apiKey: speech.apiKey ?? "",
    baseUrl: speech.baseUrl ?? "",
    sttModel: speech.sttModel,
    ttsModel: speech.ttsModel,
    ttsVoice: speech.ttsVoice,
  }
}

function isDraftEqual(a: DraftFields, b: DraftFields): boolean {
  return a.apiKey === b.apiKey && a.baseUrl === b.baseUrl && a.sttModel === b.sttModel && a.ttsModel === b.ttsModel && a.ttsVoice === b.ttsVoice
}

export const SpeechSettingsCard: Component = () => {
  const { t } = useI18n()
  const { serverSettings, updateSpeechSettings } = useConfig()
  const initialDrafts = createDraftFields(serverSettings().speech)
  const [isSaving, setIsSaving] = createSignal(false)
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saved" | "error">("saved")
  const [drafts, setDrafts] = createSignal<DraftFields>(initialDrafts)

  createEffect(() => {
    const speech = serverSettings().speech
    const nextDrafts = createDraftFields(speech)
    if (!isSaving() && !isDirty()) {
      if (!isDraftEqual(drafts(), nextDrafts)) {
        setDrafts(nextDrafts)
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
    setDrafts((current) => ({ ...current, [key]: value }))
  }

  const isDirty = createMemo(() => {
    const speech = serverSettings().speech
    const current = drafts()
    return (
      (current.apiKey || "") !== (speech.apiKey || "") ||
      (current.baseUrl || "") !== (speech.baseUrl || "") ||
      current.sttModel !== speech.sttModel ||
      current.ttsModel !== speech.ttsModel ||
      current.ttsVoice !== speech.ttsVoice
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
      await updateSpeechSettings({
        apiKey: current.apiKey.trim() || undefined,
        baseUrl: current.baseUrl.trim() || undefined,
        sttModel: current.sttModel.trim() || undefined,
        ttsModel: current.ttsModel.trim() || undefined,
        ttsVoice: current.ttsVoice.trim() || undefined,
      })
      await loadSpeechCapabilities(true)
      setDrafts({
        apiKey: current.apiKey.trim(),
        baseUrl: current.baseUrl.trim(),
        sttModel: current.sttModel.trim() || serverSettings().speech.sttModel,
        ttsModel: current.ttsModel.trim() || serverSettings().speech.ttsModel,
        ttsVoice: current.ttsVoice.trim() || serverSettings().speech.ttsVoice,
      })
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
        />
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

        <div class="settings-inline-note">{t("settings.speech.help")}</div>
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
      <div class="flex items-center gap-2 min-w-[18rem] max-w-[24rem] w-full">
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

export default SpeechSettingsCard
