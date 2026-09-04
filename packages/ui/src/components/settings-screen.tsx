import { Dialog } from "@kobalte/core/dialog"
import { Select } from "@kobalte/core/select"
import useMediaQuery from "@suid/material/useMediaQuery"
import type { LocationRef } from "@opencode-ai/client"
import { Settings, Bell, ChevronDown, FileCog, Globe, Info, MessageSquare, MonitorUp, PlugZap, SlidersHorizontal, Terminal, Volume2, X } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import {
  activeSettingsSection,
  closeSettings,
  settingsOpen,
  setActiveSettingsSection,
  type SettingsSectionId,
} from "../stores/settings-screen"
import { GeneralSettingsSection } from "./settings/general-settings-section"
import { ChatSettingsSection } from "./settings/chat-settings-section"
import { InfoSettingsSection } from "./settings/info-settings-section"
import { NotificationsSettingsSection } from "./settings/notifications-settings-section"
import { SpeechSettingsSection } from "./settings/speech-settings-section"
import { ProvidersSettingsSection } from "./settings/providers-settings-section"
import { OpenCodeSettingsSection } from "./settings/opencode-settings-section"
import { AdvancedSettingsSection } from "./settings/advanced-settings-section"
import { ConfigFilesSettingsSection } from "./settings/config-files-settings-section"
import { RemoteAccessSettingsSection } from "./settings/remote-access-settings-section"
import { SavedRemoteServersCard } from "./settings/saved-remote-servers-card"
import { SideCarsSettingsSection } from "./settings/sidecars-settings-section"
import { canOpenRemoteWindows } from "../lib/runtime-env"
import { confirmSettingsDiscard } from "../stores/settings-dirty-guard"
import { NativeTitlebar } from "./native-titlebar"

type SettingsSectionOption = {
  id: SettingsSectionId
  icon: typeof Settings
  label: string
}

interface SettingsScreenProps {
  standalone?: boolean
  providerContext?: { instanceId?: string; location?: LocationRef }
  onClose?: () => void | Promise<void>
  onSectionChange?: (section: SettingsSectionId) => void | Promise<void>
}

export const SettingsScreen: Component<SettingsScreenProps> = (props) => {
  const { t } = useI18n()
  const phoneQuery = useMediaQuery("(max-width: 640px)")

  const sections = createMemo(() => {
    const items: SettingsSectionOption[] = [
      { id: "general", icon: SlidersHorizontal, label: t("settings.nav.general") },
      { id: "chat", icon: MessageSquare, label: t("settings.nav.chat") },
      { id: "notifications", icon: Bell, label: t("settings.nav.notifications") },
      { id: "speech", icon: Volume2, label: t("settings.nav.speech") },
      { id: "opencode", icon: Terminal, label: t("settings.nav.opencode") },
      { id: "providers", icon: PlugZap, label: t("settings.nav.providers") },
      { id: "sidecars", icon: Globe, label: t("settings.nav.sidecars") },
      { id: "config-files", icon: FileCog, label: t("settings.nav.configFiles") },
      { id: "advanced", icon: Settings, label: t("settings.nav.advanced") },
      { id: "info", icon: Info, label: t("settings.nav.info") },
    ]
    if (props.standalone || canOpenRemoteWindows()) {
      items.splice(4, 0, { id: "remote", icon: MonitorUp, label: t("settings.nav.remote") })
    }
    return items
  })

  const activeSection = createMemo(() => sections().find((section) => section.id === activeSettingsSection()) ?? sections()[0])

  const renderSection = () => {
    switch (activeSettingsSection()) {
      case "chat":
        return <ChatSettingsSection />
      case "notifications":
        return <NotificationsSettingsSection />
      case "speech":
        return <SpeechSettingsSection />
      case "remote":
        return props.standalone || canOpenRemoteWindows() ? (
          <div class="settings-section-stack">
            <RemoteAccessSettingsSection />
            <SavedRemoteServersCard />
          </div>
        ) : <GeneralSettingsSection showStartupState />
      case "opencode":
        return <OpenCodeSettingsSection />
      case "providers":
        return <ProvidersSettingsSection instanceId={props.providerContext?.instanceId} location={props.providerContext?.location} />
      case "sidecars":
        return <SideCarsSettingsSection />
      case "config-files":
        return <ConfigFilesSettingsSection />
      case "advanced":
        return <AdvancedSettingsSection />
      case "info":
        return <InfoSettingsSection />
      case "general":
      default:
        return <GeneralSettingsSection showStartupState={!props.standalone} />
    }
  }

  const handleSectionChange = async (sectionId: SettingsSectionId) => {
    if (sectionId === activeSettingsSection()) return
    if (!(await confirmSettingsDiscard())) return
    await props.onSectionChange?.(sectionId)
    setActiveSettingsSection(sectionId)
  }

  const handleCloseSettings = async () => {
    if (!(await confirmSettingsDiscard())) return
    if (props.onClose) await props.onClose()
    else closeSettings()
  }

  const [windowPosition, setWindowPosition] = createSignal({ x: 0, y: 0 })
  createEffect(() => {
    if (phoneQuery()) setWindowPosition({ x: 0, y: 0 })
  })
  let settingsShell: HTMLDivElement | undefined
  let dragStart: { x: number; y: number; pointerX: number; pointerY: number; minX: number; maxX: number; minY: number; maxY: number } | undefined

  const handleDragStart = (event: PointerEvent) => {
    if (props.standalone || phoneQuery() || event.button !== 0 || (event.target as Element).closest("button, input, select, textarea, a")) return
    if (!settingsShell) return

    const position = windowPosition()
    const rect = settingsShell.getBoundingClientRect()
    dragStart = {
      ...position,
      pointerX: event.clientX,
      pointerY: event.clientY,
      minX: position.x + 16 - rect.left,
      maxX: position.x + window.innerWidth - 16 - rect.right,
      minY: position.y + 16 - rect.top,
      maxY: position.y + window.innerHeight - 16 - rect.bottom,
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const handleDragMove = (event: PointerEvent) => {
    if (!dragStart) return
    setWindowPosition({
      x: Math.min(dragStart.maxX, Math.max(dragStart.minX, dragStart.x + event.clientX - dragStart.pointerX)),
      y: Math.min(dragStart.maxY, Math.max(dragStart.minY, dragStart.y + event.clientY - dragStart.pointerY)),
    })
  }

  const handleDragEnd = (event: PointerEvent) => {
    dragStart = undefined
    const target = event.currentTarget as HTMLElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }

  const content = () => (
    <>
            <Show when={props.standalone}><h1 class="sr-only">{t("settings.title")}</h1></Show>

            <aside class="settings-screen-nav">
              <div class="settings-screen-compact-bar">
                <span class="settings-screen-compact-icon-wrap">
                  <Settings class="settings-screen-nav-icon" />
                </span>
                <div class="settings-section-selector-wrap">
                  <Select<SettingsSectionOption>
                    value={activeSection()}
                    onChange={(section) => section && void handleSectionChange(section.id)}
                    options={sections()}
                    optionValue="id"
                    optionTextValue="label"
                    itemComponent={(itemProps) => {
                      const Icon = itemProps.item.rawValue.icon
                      return (
                        <Select.Item item={itemProps.item} class="selector-option settings-section-selector-option">
                          <Icon class="settings-section-selector-option-icon" />
                          <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
                        </Select.Item>
                      )
                    }}
                  >
                    <Select.Trigger class="selector-trigger settings-section-selector-trigger" aria-label={t("settings.navigationAriaLabel")}>
                      <div class="flex-1 min-w-0">
                        <Select.Value<SettingsSectionOption>>
                          {(state) => {
                            const selected = state.selectedOption()
                            const Icon = selected?.icon ?? Settings
                            return (
                              <span class="settings-section-selector-value">
                                <Icon class="settings-section-selector-value-icon" />
                                <span class="selector-trigger-primary selector-trigger-primary--align-left">{selected?.label}</span>
                              </span>
                            )
                          }}
                        </Select.Value>
                      </div>
                      <Select.Icon class="selector-trigger-icon">
                        <ChevronDown class="w-3 h-3" />
                      </Select.Icon>
                    </Select.Trigger>

                    <Select.Portal>
                      <Select.Content class="selector-popover settings-section-selector-popover">
                        <Select.Listbox class="selector-listbox" />
                      </Select.Content>
                    </Select.Portal>
                  </Select>
                </div>
                <Show when={!props.standalone}><button
                  type="button"
                  class="selector-button selector-button-secondary settings-screen-close settings-screen-compact-close"
                  onClick={() => void handleCloseSettings()}
                  aria-label={t("settings.close")}
                  title={t("settings.close")}
                >
                  <X class="w-4 h-4" />
                </button></Show>
              </div>

              <div
                class="settings-screen-nav-header settings-screen-drag-handle"
                onPointerDown={handleDragStart}
                onPointerMove={handleDragMove}
                onPointerUp={handleDragEnd}
                onPointerCancel={handleDragEnd}
              >
                <div class="settings-screen-nav-title-row">
                  <span class="settings-screen-nav-icon-wrap">
                    <Settings class="settings-screen-nav-icon" />
                  </span>
                  <div>
                    <h2 class="settings-screen-title">{t("settings.title")}</h2>
                  </div>
                </div>
              </div>

              <nav class="settings-screen-nav-list" aria-label={t("settings.navigationAriaLabel")}>
                <For each={sections()}>
                  {(section) => {
                    const Icon = section.icon
                    return (
                      <button
                        type="button"
                        class="settings-nav-button"
                        data-selected={activeSettingsSection() === section.id ? "true" : "false"}
                        aria-current={activeSettingsSection() === section.id ? "page" : undefined}
                        onClick={() => void handleSectionChange(section.id)}
                      >
                        <Icon class="settings-nav-button-icon" />
                        <span>{section.label}</span>
                      </button>
                    )
                  }}
                </For>
              </nav>
            </aside>

            <div class="settings-screen-content">
              <header
                class="window-header settings-screen-content-header settings-screen-drag-handle"
                onPointerDown={handleDragStart}
                onPointerMove={handleDragMove}
                onPointerUp={handleDragEnd}
                onPointerCancel={handleDragEnd}
              >
                <div class="settings-screen-content-header-title-group">
                  <p class="settings-screen-content-eyebrow">{t("settings.content.eyebrow")}</p>
                  <h1 class="window-title settings-screen-content-title">
                    {activeSection()?.label}
                  </h1>
                </div>
                <Show when={!props.standalone}><button
                  type="button"
                  class="window-icon-button settings-screen-close"
                  onClick={() => void handleCloseSettings()}
                  aria-label={t("settings.close")}
                  title={t("settings.close")}
                >
                  <X class="w-4 h-4" />
                </button></Show>
              </header>

              <div class="window-body settings-screen-scroll">{renderSection()}</div>
            </div>
    </>
  )

  if (props.standalone) {
    return (
      <div class="settings-window-root">
        <NativeTitlebar title={t("settings.title")} onClose={handleCloseSettings} />
        <div ref={settingsShell} class="modal-surface window-shell settings-screen-shell">
          {content()}
        </div>
      </div>
    )
  }

  return (
    <Dialog modal={phoneQuery()} preventScroll={phoneQuery()} open={settingsOpen()} onOpenChange={(open) => !open && void handleCloseSettings()}>
      <Dialog.Portal>
        <div class="settings-screen-frame">
          <Dialog.Content
            ref={settingsShell}
            class="modal-surface window-shell settings-screen-shell"
            style={{ transform: `translate(${windowPosition().x}px, ${windowPosition().y}px)` }}
            onInteractOutside={(event) => event.preventDefault()}
          >
            <Dialog.Title class="sr-only">{t("settings.title")}</Dialog.Title>
            {content()}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}
