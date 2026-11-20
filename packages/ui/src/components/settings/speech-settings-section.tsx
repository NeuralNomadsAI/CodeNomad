import { createSignal, type Component } from "solid-js"
import { canConfigureDeviceSpeech } from "../../lib/native/device-speech"
import { openSettingsRow } from "../../stores/settings-screen"
import { useDeviceSpeechSettings } from "./use-device-speech-settings"
import { VoiceConversationCard } from "./voice-conversation-card"
import { VoiceDictationCard } from "./voice-dictation-card"
import { VoicePlaybackCard } from "./voice-playback-card"

export const SpeechSettingsSection: Component = () => {
  const [credentialsOpen, setCredentialsOpen] = createSignal(false)
  const device = canConfigureDeviceSpeech() ? useDeviceSpeechSettings() : undefined
  const settled = () => !device || Boolean(device.snapshot() || device.readFailed())
  const openCredentials = () => {
    setCredentialsOpen(true)
    void openSettingsRow("speech", "voice-playback")
  }

  return (
    <div class="settings-section-stack">
      <VoiceDictationCard device={device} settled={settled()} onCredentials={openCredentials} />
      <VoicePlaybackCard credentialsOpen={credentialsOpen()} setCredentialsOpen={setCredentialsOpen} settled={settled()} />
      <VoiceConversationCard settled={settled()} />
    </div>
  )
}
