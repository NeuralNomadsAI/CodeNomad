import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { PublicVoiceConversationConfig, VoiceConversationEngine, VoiceConversationProvider } from "../../../../server/src/api-types"
import { localTransport } from "../../lib/backend-transport"
import { useI18n } from "../../lib/i18n"
import { liveVoiceAudioUnavailable } from "../../lib/live-voice-audio"
import { hasLiveVoiceConsent } from "../../lib/live-voice-consent"
import { serverEvents } from "../../lib/server-events"
import { storage } from "../../lib/storage"
import { classicConversationUnavailable } from "../../stores/conversation-speech"
import { loadSpeechCapabilities, speechCapabilities } from "../../stores/speech"
import {
  loadVoiceConversationEngine, setVoiceConversationEngine, voiceConversationEngine, voiceConversationEngineLoaded, voiceConversationReadFailed,
} from "../../stores/voice-conversation-engine"
import { VoiceSave, VoiceSelectField, VoiceSettingsCard, VoiceTextField } from "./voice-settings-fields"

const engines = ["classic", "gemini-live", "openai-realtime"] as const
type Draft = { apiKey?: string | null; model?: string; voice?: string }

export function VoiceConversationCard(props: { settled: boolean }) {
  const { t } = useI18n()
  const [saved, setSaved] = createSignal<PublicVoiceConversationConfig>()
  const [configLoaded, setConfigLoaded] = createSignal(false)
  const [reading, setReading] = createSignal(false)
  const [readFailed, setReadFailed] = createSignal(false)
  const [changingEngine, setChangingEngine] = createSignal(false)
  const [engineFailed, setEngineFailed] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [saveFailed, setSaveFailed] = createSignal(false)
  const [drafts, setDrafts] = createSignal<Partial<Record<VoiceConversationProvider, Draft>>>({})
  let disposed = false

  const engine = createMemo<VoiceConversationEngine>(previous =>
    voiceConversationEngineLoaded() ? voiceConversationEngine() : previous, "classic")
  const supported = createMemo((previous: boolean) =>
    speechCapabilities() ? Boolean(speechCapabilities()?.voiceConversation) : previous, false)
  const provider = (): VoiceConversationProvider | undefined => {
    if (engine() === "gemini-live") return "geminiLive"
    if (engine() === "openai-realtime") return "openaiRealtime"
  }
  const config = () => { const id = provider(); return id ? saved()?.[id] : undefined }
  const draft = () => { const id = provider(); return id ? drafts()[id] ?? {} : {} }
  const edit = (patch: Draft) => {
    const id = provider()
    if (!id) return
    setSaveFailed(false)
    setDrafts(current => ({ ...current, [id]: { ...current[id], ...patch } }))
  }
  const acceptConfig = (owner: { voiceConversation?: PublicVoiceConversationConfig }) => {
    if (disposed) return
    setSaved(owner.voiceConversation)
    setConfigLoaded(true)
  }

  async function read(refresh = false) {
    if (reading() || changingEngine()) return
    setReading(true)
    setReadFailed(false)
    try {
      if (refresh) await loadSpeechCapabilities(true)
      await Promise.all([
        loadVoiceConversationEngine(refresh),
        storage.loadConfigOwner("server").then(acceptConfig),
      ])
    } catch {
      if (!disposed) setReadFailed(true)
    } finally {
      if (!disposed) setReading(false)
    }
  }

  onMount(() => {
    const unsubConfig = storage.onConfigOwnerChanged("server", acceptConfig)
    const refresh = () => void read(true)
    const unsubOpen = serverEvents.onOpen(refresh)
    window.addEventListener("focus", refresh)
    onCleanup(() => {
      disposed = true
      unsubConfig()
      unsubOpen()
      window.removeEventListener("focus", refresh)
    })
    void read()
  })

  const unavailable = () => readFailed() || voiceConversationReadFailed()
  const status = () => {
    if (unavailable()) return t("settings.voice.conversation.loadError")
    if (!voiceConversationEngineLoaded()) return t("settings.speech.status.loading")
    const selected = engine()
    if (selected === "classic") {
      const reason = classicConversationUnavailable()
      return t(reason ? `voice.command.${reason}` : "settings.voice.ready")
    }
    if (!supported()) return t("settings.voice.conversation.unsupported")
    if (!configLoaded()) return t("settings.speech.status.loading")
    if (!config()?.hasApiKey) return t("settings.voice.conversation.keyMissing")
    if (!config()?.model) return t("settings.voice.conversation.modelMissing")
    const id = selected === "gemini-live" ? "geminiLive" : "openaiRealtime"
    if (!speechCapabilities()?.voiceConversation?.[id].configured) return t("settings.voice.notConfigured")
    const reason = liveVoiceAudioUnavailable()
    if (reason) return t(`voice.command.${reason}`)
    const origin = new URL(localTransport.baseUrl ?? window.location.origin).origin
    return t(hasLiveVoiceConsent(origin, selected) ? "settings.voice.ready" : "settings.voice.conversation.confirmationRequired")
  }

  async function changeEngine(value: VoiceConversationEngine) {
    if (changingEngine() || saving() || value === engine() || (value !== "classic" && !supported())) return
    setEngineFailed(false)
    setSaveFailed(false)
    setChangingEngine(true)
    try {
      await setVoiceConversationEngine(value)
    } catch {
      if (!disposed) {
        try { await loadVoiceConversationEngine(true) } catch { if (!disposed) setReadFailed(true) }
        if (!disposed) setEngineFailed(true)
      }
    } finally {
      if (!disposed) setChangingEngine(false)
    }
  }

  const patch = createMemo(() => {
    const pending = draft()
    const current = config()
    const model = pending.model?.trim()
    const voice = pending.voice?.trim()
    return {
      ...(pending.apiKey === null ? { apiKey: null } : pending.apiKey?.trim() ? { apiKey: pending.apiKey.trim() } : {}),
      ...(model !== undefined && model !== (current?.model ?? "") ? { model: model || null } : {}),
      ...(voice !== undefined && voice !== (current?.voice ?? "") ? { voice: voice || null } : {}),
    }
  })
  const dirty = () => Object.keys(patch()).length > 0
  const editDisabled = () => saving() || changingEngine() || !configLoaded() || unavailable()
  async function save() {
    const id = provider()
    if (!id || !dirty() || editDisabled() || !supported()) return
    setSaving(true)
    setSaveFailed(false)
    try {
      acceptConfig(await storage.patchConfigOwner("server", { voiceConversation: { [id]: patch() } }))
      if (!disposed) setDrafts(current => ({ ...current, [id]: undefined }))
      await loadSpeechCapabilities(true)
    } catch {
      if (!disposed) setSaveFailed(true)
    } finally {
      if (!disposed) setSaving(false)
    }
  }

  return (
    <VoiceSettingsCard id="voice-conversation" title={t("settings.voice.conversation.title")} status={status()}
      settled={props.settled && (unavailable() || voiceConversationEngineLoaded() && configLoaded())}>
      <VoiceSelectField label={t("settings.voice.conversation.engine")} value={engine()}
        disabled={!voiceConversationEngineLoaded() || unavailable() || changingEngine() || saving()}
        onChange={value => void changeEngine(value)}
        options={engines.map(value => ({ value, label: t(`settings.voice.conversation.${value}`), disabled: value !== "classic" && !supported() }))} />
      <Show when={unavailable() || engineFailed()}>
        <div class="settings-toolbar-inline flex-wrap">
          <Show when={unavailable()} fallback={<span class="settings-inline-note" role="alert">{t("settings.voice.conversation.saveError")}</span>}>
            <button type="button" class="selector-button selector-button-secondary w-auto" disabled={reading()}
              onClick={() => void read(true)}>{t("settings.voice.retry")}</button>
          </Show>
        </div>
      </Show>
      <Show when={provider() && supported()}>
        <form class="settings-stack" onSubmit={event => { event.preventDefault(); void save() }}>
          <VoiceTextField label={t("settings.speech.apiKey.title")} value={draft().apiKey ?? ""}
            placeholder={config()?.hasApiKey && draft().apiKey !== null ? t("settings.voice.conversation.keySaved") : undefined}
            onInput={apiKey => edit({ apiKey })} disabled={editDisabled()} secret />
          <Show when={config()?.hasApiKey && !draft().apiKey?.trim()}>
            <div class="settings-toolbar-inline flex-wrap">
              <Show when={draft().apiKey === null} fallback={
                <button type="button" class="window-text-button" disabled={editDisabled()} onClick={() => edit({ apiKey: null })}>
                  {t("settings.speech.apiKey.clearAction")}
                </button>
              }>
                <span class="settings-inline-note">{t("settings.speech.apiKey.clearPending")}</span>
              </Show>
            </div>
          </Show>
          <VoiceTextField label={t("settings.voice.conversation.model")} value={draft().model ?? config()?.model ?? ""}
            onInput={model => edit({ model })} disabled={editDisabled()} />
          <VoiceTextField label={t("settings.voice.conversation.voice")} value={draft().voice ?? config()?.voice ?? ""}
            onInput={voice => edit({ voice })} disabled={editDisabled()} />
          <VoiceSave dirty={dirty() && !editDisabled()} saving={saving()}
            error={saveFailed() ? t("settings.voice.conversation.saveError") : undefined} />
        </form>
      </Show>
    </VoiceSettingsCard>
  )
}
