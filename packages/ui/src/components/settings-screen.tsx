import { Dialog } from "@kobalte/core/dialog"
import { Select } from "@kobalte/core/select"
import useMediaQuery from "@suid/material/useMediaQuery"
import { Settings, Bell, ChevronDown, FileCog, Flag, Globe, Info, Keyboard, MessageSquare, MonitorUp, PlugZap, SlidersHorizontal, Terminal, Volume2, X } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import {
  activeSettingsSection,
  closeSettings,
  settingsOpen,
  settingsRowPending,
  setActiveSettingsSection,
  type SettingsSectionId,
} from "../stores/settings-screen"
import { GeneralSettingsSection } from "./settings/general-settings-section"
import { ChatSettingsSection } from "./settings/chat-settings-section"
import { HotkeysSettingsSection } from "./settings/hotkeys-settings-section"
import { InfoSettingsSection } from "./settings/info-settings-section"
import { NotificationsSettingsSection } from "./settings/notifications-settings-section"
import { SpeechSettingsSection } from "./settings/speech-settings-section"
import { ProvidersSettingsSection } from "./settings/providers-settings-section"
import { UsageSettingsSection } from "./settings/usage-settings-section"
import { BarChart3 } from "lucide-solid"
import { OpenCodeSettingsSection } from "./settings/opencode-settings-section"
import { AdvancedSettingsSection } from "./settings/advanced-settings-section"
import { ConfigFilesSettingsSection } from "./settings/config-files-settings-section"
import { RemoteAccessSettingsSection } from "./settings/remote-access-settings-section"
import { RemoteControlSettingsSection } from "./settings/remote-control-settings-section"
import { SavedRemoteServersCard } from "./settings/saved-remote-servers-card"
import { SideCarsSettingsSection } from "./settings/sidecars-settings-section"
import { MissionsSettingsSection } from "./settings/missions-settings-section"
import { canOpenRemoteWindows } from "../lib/runtime-env"
import { confirmSettingsDiscard } from "../stores/settings-dirty-guard"
import { NativeTitlebar } from "./native-titlebar"
import { createSettingsScrollRestoration } from "./settings/settings-scroll-restoration"
import type { PreferencesProjectContext } from "./settings/preferences-project-context"
import type { NativePreferencesRequest } from "../lib/native/preferences-window"
import { activeInstanceId, instances } from "../stores/instances"
import { LOCAL_SERVER_ID } from "../lib/project-identity"
import { LocalBackendSettings } from "./settings/local-backend-settings"
import { getActiveCatalogLocation } from "../stores/sessions"

type SettingsSectionOption = {
  id: SettingsSectionId
  icon: typeof Settings
  label: string
}

interface SettingsScreenProps {
  standalone?: boolean
  executionRequest?: NativePreferencesRequest
  projectContext?: PreferencesProjectContext
  onClose?: () => void | Promise<void>
  onSectionChange?: (section: SettingsSectionId) => void | Promise<void>
  scrollPosition?: { scrollTop?: number }
  onScrollPositionChange?: (top: number) => void
}

export const SettingsScreen: Component<SettingsScreenProps> = (props) => {
  const { t } = useI18n()
  const phoneQuery = useMediaQuery("(max-width: 640px)")
  const selectedId = () => props.executionRequest?.instanceId ?? (props.standalone ? "" : activeInstanceId()) ?? ""
  const selectedServer = () => props.standalone ? props.executionRequest?.serverId ?? LOCAL_SERVER_ID
    : instances().get(selectedId())?.binding?.serverId ?? LOCAL_SERVER_ID
  const local = () => selectedServer() === LOCAL_SERVER_ID
  const localBackendAutomatic = () => local() && (!selectedId() || Boolean(project()))
  const project = createMemo<PreferencesProjectContext | undefined>(() => {
    if (props.standalone) return props.projectContext
    const instance = instances().get(selectedId())
    if (!instance || instance.status !== "ready") return
    return { instanceId: instance.id, serverId: instance.binding?.serverId, workspacePath: instance.folder,
      location: getActiveCatalogLocation(instance.id),
      binding: instance.binding ?? { serverId: LOCAL_SERVER_ID, directory: instance.folder }, capabilities: instance.capabilities }
  })
  const catalogue = () => {
    const value = project()
    return value && (local() || value.capabilities?.features?.chat?.state === "available") ? value : undefined
  }
  const execution = () => {
    const value = project(), state = value?.capabilities?.features?.executionSettings?.state
    return local() && value && (!value.capabilities || state === "available" || state === "unknown") ? value : undefined
  }
  // Consent and retained callbacks are fenced by the accepted request and fresh capability snapshot.
  const target = () => JSON.stringify([selectedServer(), selectedId(), props.executionRequest?.workspacePath,
    props.executionRequest?.location, project()?.location, project()?.binding, project()?.capabilities])
  const unavailable = () => <p class="settings-card-message" role="status">{t(project() ? "settings.execution.deferred" : "settings.execution.unavailable")}</p>
  const providers = () => <ProvidersSettingsSection instanceId={project()?.instanceId ?? ""} location={project()?.location}
    executionContext={execution()} catalogueContext={catalogue()} scoped />

  const sections = createMemo(() => {
    const items: SettingsSectionOption[] = [
      { id: "general", icon: SlidersHorizontal, label: t("settings.nav.general") },
      { id: "chat", icon: MessageSquare, label: t("settings.nav.chat") },
      { id: "hotkeys", icon: Keyboard, label: t("settings.nav.hotkeys") },
      { id: "notifications", icon: Bell, label: t("settings.nav.notifications") },
      { id: "speech", icon: Volume2, label: t("settings.nav.speech") },
      { id: "opencode", icon: Terminal, label: t("settings.nav.opencode") },
      { id: "providers", icon: PlugZap, label: t("settings.nav.providers") },
      { id: "missions", icon: Flag, label: t("settings.nav.missions") },
      { id: "usage", icon: BarChart3, label: t("settings.usage.title") },
      { id: "sidecars", icon: Globe, label: t("settings.nav.sidecars") },
      { id: "config-files", icon: FileCog, label: t("settings.nav.configFiles") },
      { id: "advanced", icon: Settings, label: t("settings.nav.advanced") },
      { id: "info", icon: Info, label: t("settings.nav.info") },
    ]
    items.splice(5, 0, { id: "remote", icon: MonitorUp, label: t("settings.nav.remote") })
    return items
  })

  const activeSection = createMemo(() => sections().find((section) => section.id === activeSettingsSection()) ?? sections()[0])

  const renderSection = () => {
    switch (activeSettingsSection()) {
      case "chat":
        return <ChatSettingsSection />
      case "hotkeys":
        return <HotkeysSettingsSection />
      case "notifications":
        return <NotificationsSettingsSection />
      case "speech":
        return <SpeechSettingsSection />
      case "remote":
        return (
          <div class="settings-section-stack">
            <RemoteControlSettingsSection />
            <RemoteAccessSettingsSection />
            <Show when={canOpenRemoteWindows()}>
              <SavedRemoteServersCard />
            </Show>
          </div>
        )
      case "opencode":
        return <LocalBackendSettings target={target()} local={localBackendAutomatic()}>{active => <OpenCodeSettingsSection active={active} />}</LocalBackendSettings>
      case "providers":
        return providers()
      case "missions":
        return <Show when={target()} keyed>{authority => <MissionsSettingsSection instanceId={catalogue()?.instanceId ?? ""} location={catalogue()?.location}
          catalogueActive={() => target() === authority && Boolean(catalogue())} executionActive={() => target() === authority && Boolean(execution())} authority={authority} />}</Show>
      case "usage":
        return <Show when={execution()} keyed fallback={unavailable()}>{context => <UsageSettingsSection instanceId={context.instanceId} active={() => execution() === context} />}</Show>
      case "sidecars":
        return <SideCarsSettingsSection />
      case "config-files":
        return <LocalBackendSettings target={target()} local={localBackendAutomatic()}>{active => <ConfigFilesSettingsSection active={active} />}</LocalBackendSettings>
      case "advanced":
        return <AdvancedSettingsSection local={localBackendAutomatic()} target={target()} />
      case "info":
        return <InfoSettingsSection localService={localBackendAutomatic()} />
      case "general":
      default:
        return <GeneralSettingsSection startupStateOwner={props.standalone ? "opener" : "self"} />
    }
  }

  const handleSectionChange = async (sectionId: SettingsSectionId) => {
    if (sectionId === activeSettingsSection()) return
    if (!(await confirmSettingsDiscard())) return
    await props.onSectionChange?.(sectionId)
    setActiveSettingsSection(sectionId)
    settingsScroll?.scrollTo({ top: 0 })
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
  let settingsScroll: HTMLDivElement | undefined
  createSettingsScrollRestoration(() => settingsScroll, () => {
    activeSettingsSection()
    return props.scrollPosition
  }, top => props.onScrollPositionChange?.(top))
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
              <div class="window-toolbar settings-screen-compact-bar">
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
                  class="window-icon-button settings-screen-close settings-screen-compact-close"
                  onClick={() => void handleCloseSettings()}
                  aria-label={t("settings.close")}
                  title={t("settings.close")}
                >
                  <X class="w-4 h-4" />
                </button></Show>
              </div>

              <div
                class="window-header settings-screen-nav-header settings-screen-drag-handle"
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
                    <h2 class="window-title settings-screen-title">{t("settings.title")}</h2>
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

              <div ref={settingsScroll} class="window-body settings-screen-scroll">
                <div class="settings-card-message" role="note" data-settings-execution-scope>
                  <p>{t("settings.execution.shared")}</p>
                  <p class="break-all">{t("settings.execution.target")}: <bdi>{selectedServer()}</bdi>
                    <Show when={props.executionRequest?.workspacePath ?? project()?.workspacePath}>{path => <> · <bdi>{path()}</bdi></>}</Show></p>
                </div>
                {renderSection()}
              </div>
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
            // A linked setting row takes focus itself instead of the first control.
            onOpenAutoFocus={(event) => { if (settingsRowPending()) event.preventDefault() }}
          >
            <Dialog.Title class="sr-only">{t("settings.title")}</Dialog.Title>
            {content()}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}
