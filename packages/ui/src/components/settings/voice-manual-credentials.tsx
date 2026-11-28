import { For, Show, createMemo, createSignal } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { buildDirSave } from "../../lib/speech-dir-save"
import { useConfig, type SpeechSettingsUpdate } from "../../stores/preferences"
import { loadSpeechCapabilities, serverSupportsSeparateProviders, speechCapabilities } from "../../stores/speech"
import { SettingsSwitch } from "./settings-switch"
import { VoiceSave, VoiceTextField } from "./voice-settings-fields"

type Direction = "shared" | "stt" | "tts"
type CredentialDraft = { apiKey?: string | null; baseUrl?: string; model?: string }
const directions = ["shared", "stt", "tts"] as const
const prefix = (dir: Direction) => dir === "shared" ? "settings.speech" : `settings.speech.${dir}`

export function VoiceManualCredentials() {
  const { t } = useI18n()
  const config = useConfig()
  const [drafts, setDrafts] = createSignal<Partial<Record<Direction, CredentialDraft>>>({})
  const [ttsModel, setTtsModel] = createSignal<string>()
  const [separateDraft, setSeparate] = createSignal<boolean>()
  const [saving, setSaving] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const speech = () => config.serverSettings().speech
  const separateSupported = createMemo((previous: boolean) =>
    speechCapabilities() ? serverSupportsSeparateProviders() : previous, false)
  const separate = () => separateSupported() && (separateDraft() ?? speech().separateProviders)
  const saved = (dir: Direction) => dir === "shared" ? { ...speech(), model: speech().sttModel } : speech()[dir]
  const draft = (dir: Direction) => drafts()[dir] ?? {}
  const edit = (dir: Direction, fields: CredentialDraft) => {
    setFailed(false)
    setDrafts(current => ({ ...current, [dir]: { ...current[dir], ...fields } }))
  }
  const baseUrl = (dir: Direction) => draft(dir).baseUrl ?? saved(dir).baseUrl ?? ""
  const model = (dir: Direction) => draft(dir).model ?? saved(dir).model
  const patch = createMemo(() => {
    const existing = speech()
    const sharedKey = draft("shared").apiKey
    const sharedUrl = baseUrl("shared").trim()
    const sharedUrlChanged = sharedUrl !== (existing.baseUrl ?? "")
    const update: SpeechSettingsUpdate = {
      ...(separateSupported() && separate() !== existing.separateProviders ? { separateProviders: separate() } : {}),
      ...(sharedKey === null || sharedUrlChanged || sharedKey?.trim()
        ? { apiKey: sharedKey?.trim() || null, baseUrl: sharedUrl || null } : {}),
      ...(model("shared").trim() !== existing.sttModel ? { sttModel: model("shared") } : {}),
      ...(ttsModel() !== undefined && ttsModel()?.trim() !== existing.ttsModel ? { ttsModel: ttsModel() } : {}),
    }
    if (separate()) {
      for (const dir of ["stt", "tts"] as const) {
        const key = draft(dir).apiKey
        const url = baseUrl(dir).trim()
        const name = model(dir).trim()
        const direction = existing[dir]
        const sharedModel = dir === "stt" ? (update.sttModel ?? existing.sttModel) : (update.ttsModel ?? existing.ttsModel)
        if (key === null || key?.trim() || url !== (direction.baseUrl ?? "") || name !== direction.model) {
          update[dir] = buildDirSave(key === null, key ?? "", url, name, direction.baseUrl, sharedModel)
          // An explicit credential write always carries the endpoint shown beside it.
          if (key?.trim()) update[dir].baseUrl = url || null
        }
      }
    }
    return update
  })
  const dirty = () => Object.keys(patch()).length > 0

  async function save() {
    if (!dirty() || saving() || !config.isLoaded()) return
    setSaving(true)
    setFailed(false)
    try {
      await config.updateSpeechSettings(patch())
      setDrafts({})
      setTtsModel(undefined)
      setSeparate(undefined)
      await loadSpeechCapabilities(true)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form class="settings-stack" onSubmit={event => { event.preventDefault(); void save() }}>
      <Show when={separateSupported()}>
        <div class="settings-toggle-row settings-toggle-row-compact">
          <span class="settings-toggle-title">{t("settings.speech.separateProviders.title")}</span>
          <SettingsSwitch checked={separate()} label={t("settings.speech.separateProviders.title")} disabled={saving()}
            onChange={value => { setFailed(false); setSeparate(value) }} />
        </div>
      </Show>
      <For each={directions}>{dir => (
        <Show when={dir === "shared" || separate()}>
          <Show when={dir !== "shared"}>
            <div class="settings-card-section-header">
              <h4 class="settings-card-section-title">{t(`${prefix(dir)}.section.title`)}</h4>
            </div>
          </Show>
          <VoiceTextField
            label={t(`${prefix(dir)}.apiKey.title`)}
            info={saved(dir).hasApiKey && draft(dir).apiKey !== null ? t(`${prefix(dir)}.apiKey.storedNote`) : undefined}
            placeholder={saved(dir).hasApiKey && draft(dir).apiKey !== null ? t("settings.voice.conversation.keySaved") : undefined}
            disabled={saving()} secret value={draft(dir).apiKey ?? ""}
            onInput={apiKey => edit(dir, { apiKey, baseUrl: baseUrl(dir) })}
          />
          <Show when={saved(dir).hasApiKey && !draft(dir).apiKey?.trim()}>
            <Show when={draft(dir).apiKey === null} fallback={
              <div class="settings-toolbar-inline">
                <button type="button" class="window-text-button" disabled={saving()} onClick={() => edit(dir, { apiKey: null })}>
                  {t(`${prefix(dir)}.apiKey.clearAction`)}
                </button>
              </div>
            }>
              <div class="settings-inline-note">{t(`${prefix(dir)}.apiKey.clearPending`)}</div>
            </Show>
          </Show>
          <VoiceTextField label={t(`${prefix(dir)}.baseUrl.title`)} info={t(`${prefix(dir)}.baseUrl.subtitle`)}
            placeholder={t(`${prefix(dir)}.baseUrl.placeholder`)} disabled={saving()} value={baseUrl(dir)}
            onInput={baseUrl => edit(dir, { baseUrl })} />
          <VoiceTextField label={t(`${prefix(dir)}.${dir === "shared" ? "sttModel" : "model"}.title`)}
            disabled={saving()} value={model(dir)} onInput={model => edit(dir, { model })} />
          <Show when={dir === "shared"}>
            <VoiceTextField label={t("settings.speech.ttsModel.title")} disabled={saving()} value={ttsModel() ?? speech().ttsModel}
              onInput={value => { setFailed(false); setTtsModel(value) }} />
          </Show>
        </Show>
      )}</For>
      <VoiceSave dirty={dirty() && config.isLoaded()} saving={saving()} error={failed() ? t("settings.speech.save.error") : undefined} />
    </form>
  )
}
