import { createMemo, type Component } from "solid-js"
import { getBehaviorSettings } from "../../lib/settings/behavior-registry"
import { useConfig } from "../../stores/preferences"
import { BehaviorSettingRows } from "./behavior-setting-rows"
import SpeechSettingsCard from "./speech-settings-card"

export const SpeechSettingsSection: Component = () => {
  const config = useConfig()
  const voiceSettings = createMemo(() =>
    getBehaviorSettings(config).filter((setting) => setting.id === "behavior.promptVoiceInput"),
  )

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-stack">
          <BehaviorSettingRows settings={voiceSettings} preferences={config.preferences} />
        </div>
      </div>
      <SpeechSettingsCard />
    </div>
  )
}
