import { createMemo, lazy, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getBehaviorSettings } from "../../lib/settings/behavior-registry"
import { isDesktopHost, isNativeApplicationWindow } from "../../lib/runtime-env"
import { useConfig } from "../../stores/preferences"
import { LocaleSelector } from "../locale-selector"
import { BehaviorSettingRows } from "./behavior-setting-rows"
import { ThemeSchemeSettings } from "./theme-scheme-settings"
import type { LocationRef } from "@opencode/client"
import { AgentMemorySettingsCard } from "./agent-memory-settings-card"

const StartupStateSettingsCard = lazy(() => import("./startup-state-settings-card").then((module) => ({ default: module.StartupStateSettingsCard })))
const OpenerStartupStateSettingsCard = lazy(() => import("./opener-startup-state-settings-card").then((module) => ({ default: module.OpenerStartupStateSettingsCard })))

interface GeneralSettingsSectionProps {
  instanceId?: string
  serverId?: string
  projectUnavailable?: boolean
  location?: LocationRef
  showStartupState?: boolean
  /** "opener": the native Preferences window, which never owns client state. */
  startupStateOwner?: "self" | "opener"
}

export const GeneralSettingsSection: Component<GeneralSettingsSectionProps> = (props) => {
  const { t } = useI18n()
  const config = useConfig()
  const generalSettings = createMemo(() =>
    getBehaviorSettings(config).filter(
      (setting) =>
        setting.id === "behavior.messageTimeline" ||
        setting.id === "behavior.scrollControlsInTimelineCorner" ||
        setting.id === "behavior.autoExpandActiveSubsessions" ||
        setting.id === "behavior.diffViewMode" ||
        setting.id === "behavior.followUpBehavior" ||
        (setting.id === "behavior.keepComputerAwake" && isDesktopHost() && isNativeApplicationWindow()),
    ),
  )

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header settings-language-row">
          <div>
            <h3 class="settings-card-title">{t("folderSelection.language.ariaLabel")}</h3>
            <p class="settings-card-subtitle">{t("settings.general.language.subtitle")}</p>
          </div>
          <LocaleSelector />
        </div>
      </div>
      <ThemeSchemeSettings />
      <AgentMemorySettingsCard instanceId={props.instanceId} serverId={props.serverId} location={props.location} unavailable={props.projectUnavailable} />

      <Show when={props.showStartupState !== false}>
        <Show when={props.startupStateOwner === "opener"} fallback={<StartupStateSettingsCard />}>
          <OpenerStartupStateSettingsCard />
        </Show>
      </Show>

      <div class="settings-card">
        <div class="settings-stack">
          <BehaviorSettingRows settings={generalSettings} preferences={config.preferences} />
        </div>
      </div>

    </div>
  )
}
