import type { Component } from "solid-js"
import SpeechSettingsCard from "./speech-settings-card"

export const SpeechSettingsSection: Component = () => {
  return (
    <div class="settings-section-stack">
      <SpeechSettingsCard />
    </div>
  )
}
