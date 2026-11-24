import { Show, createMemo, onCleanup } from "solid-js"
import { Loader2, Mic, Square } from "lucide-solid"
import { useTranscriptionTest } from "../../lib/hooks/use-transcription-test"
import { useI18n } from "../../lib/i18n"
import { getBehaviorSettings } from "../../lib/settings/behavior-registry"
import { useConfig } from "../../stores/preferences"
import { speechCapabilities, speechCapabilitiesError } from "../../stores/speech"
import { useRemoteDictation } from "../prompt-input/useRemoteDictation"
import { BehaviorSettingRows } from "./behavior-setting-rows"
import { DeviceSpeechSettings, deviceHexLabel } from "./device-speech-settings"
import type { useDeviceSpeechSettings } from "./use-device-speech-settings"
import { VoiceSettingsCard } from "./voice-settings-fields"

export function VoiceDictationCard(props: {
  device?: ReturnType<typeof useDeviceSpeechSettings>
  settled: boolean
  onCredentials: () => void
}) {
  const { t, locale } = useI18n()
  const config = useConfig()
  const voiceSetting = createMemo(() =>
    getBehaviorSettings(config).filter(setting => setting.id === "behavior.promptVoiceInput"),
  )
  const device = props.device
  const remote = useRemoteDictation(locale, () => !device)
  const remoteChoice = () => remote?.choice()
  const visibleEngine = () => {
    if (!remote) return t("settings.speech.device.api")
    const choice = remoteChoice()
    return choice ? t(`settings.speech.device.${choice}`) : t("settings.voice.unavailable")
  }
  let testButton: HTMLButtonElement | undefined
  let transcribeButton: HTMLButtonElement | undefined
  let restoreAfterTranscribe = false
  const stopRestoringFocus = () => {
    restoreAfterTranscribe = false
    document.removeEventListener("focusin", stopRestoringFocus)
  }
  onCleanup(stopRestoringFocus)
  const test = useTranscriptionTest(next => {
    if (next === "idle" && restoreAfterTranscribe) queueMicrotask(() => {
      const restore = restoreAfterTranscribe && test.result() !== null && document.activeElement === document.body
      stopRestoringFocus()
      if (restore) testButton?.focus({ preventScroll: true })
    })
    if (next !== "limitReached" || !test.isRecording() || document.activeElement !== testButton) return
    queueMicrotask(() => {
      if (document.activeElement === document.body || document.activeElement === testButton) {
        transcribeButton?.focus({ preventScroll: true })
      }
    })
  })
  const status = () => {
    if (!config.preferences().showPromptVoiceInput) return t("settings.voice.dictation.off")
    if (device?.readFailed()) return t("settings.voice.unavailable")
    if (remote?.readFailed()) return t("settings.speech.device.readFailed")
    if (!props.settled) return t("settings.speech.status.loading")
    const snapshot = device?.snapshot()
    if (snapshot?.engine === "hex") {
      const key = deviceHexLabel(snapshot)
      return t(key === "settings.speech.device.hex" ? "settings.voice.ready" : key)
    }
    const choice = remoteChoice()
    if (snapshot?.engine === null || choice === null) return t("settings.speech.device.chooseLocal")
    if (remote && choice !== "api") return t(choice ? "settings.voice.ready" : "settings.voice.unavailable")
    if (speechCapabilitiesError()) return t("settings.speech.status.error")
    const capabilities = speechCapabilities()
    if (!capabilities) return t("settings.speech.status.loading")
    if (!capabilities.available || !capabilities.supportsStt) return t("settings.voice.unavailable")
    if (!capabilities.sttConfigured) return t("settings.voice.notConfigured")
    return t(test.canUseTranscription() ? "settings.voice.ready" : "settings.voice.unavailable")
  }

  return (
    <VoiceSettingsCard id="voice-dictation" title={t("settings.voice.dictation.title")} status={status()} settled={props.settled}>
      <BehaviorSettingRows settings={voiceSetting} preferences={config.preferences} />
      <Show when={device} fallback={
        <div class="settings-toggle-row settings-toggle-row-compact">
          <span class="settings-toggle-title">{t("settings.speech.device.engine")}</span>
          <span class="settings-inline-note">{visibleEngine()}</span>
        </div>
      }>
        {settings => <DeviceSpeechSettings speech={settings()} />}
      </Show>
      <div class="settings-toolbar-inline flex-wrap">
        <button type="button" class="window-text-button" onClick={props.onCredentials}>
          {t("settings.voice.credentials.title")}
        </button>
        <Show when={test.state() === "limitReached"} fallback={
          <button
            ref={testButton}
            type="button"
            class="selector-button selector-button-secondary w-auto inline-flex items-center gap-2"
            onClick={() => void test.toggle()}
            disabled={test.state() === "starting" || test.isTranscribing() || (test.state() === "idle" && !test.canUseTranscription())}
          >
            <Show when={test.state() === "starting" || test.isTranscribing()} fallback={
              <Show when={test.isRecording()} fallback={<Mic class="size-3.5" aria-hidden="true" />}>
                <Square class="size-3.5" aria-hidden="true" />
              </Show>
            }>
              <span class="inline-flex animate-spin"><Loader2 class="size-3.5" aria-hidden="true" /></span>
            </Show>
            {test.buttonTitle()}
          </button>
        }>
          <span class="settings-inline-note" role="status">{t("promptInput.voiceInput.limitReached")}</span>
          <button ref={transcribeButton} type="button" class="selector-button selector-button-secondary w-auto" onClick={({ currentTarget }) => {
            restoreAfterTranscribe = currentTarget === document.activeElement
            if (restoreAfterTranscribe) document.addEventListener("focusin", stopRestoringFocus)
            test.confirmTranscription()
          }}>
            {t("promptInput.voiceInput.transcribe")}
          </button>
          <button type="button" class="selector-button selector-button-secondary w-auto" onClick={({ currentTarget }) => {
            const restoreFocus = currentTarget === document.activeElement
            test.cancelRecording()
            if (restoreFocus && document.activeElement === document.body) testButton?.focus({ preventScroll: true })
          }}>
            {t("alertDialog.actions.cancel")}
          </button>
        </Show>
        <Show when={test.result()}>
          {text => <span class="settings-inline-note break-words min-w-0" role="status">{text()}</span>}
        </Show>
      </div>
    </VoiceSettingsCard>
  )
}
