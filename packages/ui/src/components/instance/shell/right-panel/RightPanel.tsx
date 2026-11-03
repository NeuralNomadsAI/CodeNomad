import { For, Show, Suspense, createEffect, createMemo, createSignal, createUniqueId, type Accessor, type Component } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
  createSortable,
  type DragEvent as SolidDndDragEvent,
} from "@thisbeyond/solid-dnd"
import IconButton from "@suid/material/IconButton"
import { Settings2 } from "lucide-solid"
import TabScroll from "../../../tab-scroll"

import type { Instance } from "../../../../types/instance"
import type { Session } from "../../../../types/session"
import type { PromptInputApi } from "../../../prompt-input/types"
import type { RightPanelTab } from "./types"

import { readClientLayoutValue, writeClientLayoutValue } from "../../../../stores/client-state"
import { RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY, RIGHT_PANEL_TAB_STORAGE_KEY, readStoredRightPanelTab } from "../storage"
import {
  applyRightPanelItemCustomization,
  collectRightPanelItems,
  parseRightPanelCustomization,
  type RightPanelCustomization,
  type RightPanelItem,
  type RightPanelSectionModule,
  type RightPanelTabModule,
} from "./registry"
import { createCoreRightPanelRuntime } from "./core-runtime"
import { createMissionsRightPanelModule } from "./missions-plugin"
import { FILES_PANEL_MIGRATION_KEY, mergeFilesPanelCustomization } from "./files-panel-state"
import { CORE_STATUS_SECTION_ITEMS } from "./tabs/status-sections"
import { useI18n } from "../../../../lib/i18n"
import { useTheme } from "../../../../lib/theme"
import { ExtensionPanel } from "../../../panel-extensions/extension-panel"
import { usePanelExtensions } from "../../../panel-extensions/use-panel-extensions"
import { RightPanelCustomizationPopover } from "./RightPanelCustomizationPopover"
import { createIntegrationStatusModule } from "./integration-status-module"
import type { RightPanelModule } from "./registry"

function RightPanelTabFallback() {
  return <div class="flex-1 min-h-0" />
}

interface SortableRightPanelTabProps {
  tab: RightPanelTabModule
  active: boolean
  tabId: string
  panelId: string
  label: string
  dragTitle: string
  tabIndex: number
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent) => void
}

const SortableRightPanelTab: Component<SortableRightPanelTabProps> = (props) => {
  const sortable = createSortable(props.tab.id)
  return (
    <div ref={sortable} class={`right-panel-tab-draggable ${sortable.isActiveDraggable ? "right-panel-tab-draggable-active" : ""}`}>
      <button
        type="button"
        role="tab"
        id={props.tabId}
        data-tab-id={props.tab.id}
        class={`right-panel-tab ${props.active ? "right-panel-tab-active" : "right-panel-tab-inactive"}`}
        aria-selected={props.active}
        aria-controls={props.panelId}
        tabIndex={props.tabIndex}
        title={props.dragTitle}
        onClick={props.onSelect}
        onKeyDown={props.onKeyDown}
      >
        <span class="tab-label">{props.label}</span>
      </button>
    </div>
  )
}

interface RightPanelProps {
  isActive: Accessor<boolean>
  t: (key: string, vars?: Record<string, any>) => string

  instanceId: string
  instance: Instance

  activeSessionId: Accessor<string | null>
  activeSession: Accessor<Session | null>
  onRestoreConversation?: () => void

  isPhoneLayout: Accessor<boolean>
  rightDrawerWidth: Accessor<number>
  rightDrawerWidthInitialized: Accessor<boolean>
  onCloseRightDrawer: () => void
  promptInputApi: Accessor<PromptInputApi | null>

  /** Target of the shell's fixed panel toggle. */
  panelId?: string
  setContentEl: (el: HTMLElement | null) => void
}

const RightPanel: Component<RightPanelProps> = (props) => {
  const { locale } = useI18n()
  const theme = useTheme()
  const extensions = usePanelExtensions(() => props.instanceId, props.isActive)
  const savedTab = readStoredRightPanelTab("files")
  const [rightPanelTab, setRightPanelTab] = createSignal<RightPanelTab>(savedTab === "git-changes" ? "files" : savedTab)
  const defaultStatusSectionIds = CORE_STATUS_SECTION_ITEMS.map((section) => section.id)
  const [rightPanelExpandedItems, setRightPanelExpandedItems] = createSignal<string[]>(defaultStatusSectionIds)
  const [rightPanelCustomizationOpen, setRightPanelCustomizationOpen] = createSignal(false)
  createEffect(() => { props.instanceId; props.isActive(); setRightPanelCustomizationOpen(false) })
  let customizationTriggerRef: HTMLButtonElement | undefined
  let savedCustomization = parseRightPanelCustomization(readClientLayoutValue(RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY))
  if (!readClientLayoutValue(FILES_PANEL_MIGRATION_KEY)) {
    savedCustomization = mergeFilesPanelCustomization(savedCustomization)
    writeClientLayoutValue(RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY, JSON.stringify(savedCustomization))
    writeClientLayoutValue(FILES_PANEL_MIGRATION_KEY, "1")
  }
  const [rightPanelCustomization, setRightPanelCustomization] = createSignal<RightPanelCustomization>(savedCustomization)
  const tabGroupId = `right-panel-${createUniqueId()}`
  const tabId = (id: string) => `${tabGroupId}-tab-${id}`
  const tabPanelId = (id: string) => `${tabGroupId}-panel-${id}`

  createEffect(() => {
    writeClientLayoutValue(RIGHT_PANEL_TAB_STORAGE_KEY, rightPanelTab())
  })

  const handleAccordionChange = (values: string[]) => {
    setRightPanelExpandedItems(values)
  }

  const updateRightPanelCustomization = (updater: (current: RightPanelCustomization) => RightPanelCustomization) => {
    const next = updater(rightPanelCustomization())
    setRightPanelCustomization(next)
    writeClientLayoutValue(RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY, JSON.stringify(next))
  }

  const moveTab = (sourceId: string, targetId: string) => {
    if (!sourceId || sourceId === targetId) return
    const visibleIds = visibleRightPanelTabs().map((tab) => tab.id)
    const sourceIndex = visibleIds.indexOf(sourceId)
    const targetIndex = visibleIds.indexOf(targetId)
    if (sourceIndex === -1 || targetIndex === -1) return
    const nextVisibleIds = [...visibleIds]
    const [moved] = nextVisibleIds.splice(sourceIndex, 1)
    nextVisibleIds.splice(targetIndex, 0, moved)
    const allIds = allRightPanelTabs().map((tab) => tab.id)
    updateRightPanelCustomization((current) => ({
      ...current,
      tabOrder: [...nextVisibleIds, ...allIds.filter((id) => !nextVisibleIds.includes(id))],
    }))
  }

  const handleTabDragEnd = ({ draggable, droppable }: SolidDndDragEvent) => {
    if (!droppable) return
    moveTab(String(draggable.id), String(droppable.id))
  }

  const handleTabKeyDown = (event: KeyboardEvent, currentTabId: string) => {
    const tabs = visibleRightPanelTabs()
    const index = tabs.findIndex((tab) => tab.id === currentTabId)
    if (index === -1) return

    let target: RightPanelTabModule | undefined
    const direction = event.currentTarget instanceof HTMLElement && getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1
    if (event.key === "ArrowLeft") target = tabs[(index - direction + tabs.length) % tabs.length]
    if (event.key === "ArrowRight") target = tabs[(index + direction + tabs.length) % tabs.length]
    if (event.key === "Home") target = tabs[0]
    if (event.key === "End") target = tabs[tabs.length - 1]
    if (!target) return

    event.preventDefault()
    setRightPanelTab(target.id)
    queueMicrotask(() => document.getElementById(tabId(target.id))?.focus())
  }

  const coreModule = createCoreRightPanelRuntime({
    isActive: props.isActive,
    t: props.t,
    instanceId: props.instanceId,
    get instance() { return props.instance },
    activeSessionId: props.activeSessionId,
    activeSession: props.activeSession,
    isPhoneLayout: props.isPhoneLayout,
    rightDrawerWidth: props.rightDrawerWidth,
    rightDrawerWidthInitialized: props.rightDrawerWidthInitialized,
    promptInputApi: props.promptInputApi,
    rightPanelTab,
    expandedItems: rightPanelExpandedItems,
    onExpandedItemsChange: handleAccordionChange,
    customization: rightPanelCustomization,
    onCustomizationChange: updateRightPanelCustomization,
    extraStatusSections: () => extraStatusSections(),
    extraStatusContent: () => extraStatusContent(),
  })
  const missionsModule = createMissionsRightPanelModule({
    instanceId: props.instanceId,
    t: props.t,
    activeSessionId: props.activeSessionId,
    isActive: () => props.isActive() && rightPanelTab() === "missions",
    revealConversation: restoreChat => {
      if (restoreChat) props.onRestoreConversation?.()
      if (props.isPhoneLayout()) props.onCloseRightDrawer()
    },
  })

  const extensionForTab = (id: string) => extensions.entries().find(entry => id === `extension:${entry.manifest.id}`)
  // API 4 host actions: the displayed conversation's composer, and closing the phone's floating panel.
  const extensionHost = { promptInputApi: props.promptInputApi, activeSessionId: props.activeSessionId,
    isPhoneLayout: props.isPhoneLayout, closePanel: () => props.onCloseRightDrawer() }
  const externalModules = createMemo<RightPanelModule[]>(() => extensions.entries().map(entry => {
    const id = `extension:${entry.manifest.id}`
    return { id, displayNameKey: "", origin: "external", tabs: [{ id, labelKey: "", label: entry.manifest.name, order: 1000,
      render: () => <ExtensionPanel entry={entry} instanceId={props.instanceId} active={entry.enabled && extensions.verified() && props.isActive() && rightPanelTab() === id}
        context={{ apiVersion: 1, sessionId: props.activeSessionId(), locale: locale(), appearance: theme.isDark() ? "dark" : "light" }}
        host={extensionHost} />,
    }] }
  }))
  const integrationModule = createIntegrationStatusModule({
    instanceId: props.instanceId,
    folder: () => props.instance.folder,
    t: props.t,
    isActive: () => props.isActive() && rightPanelTab() === "status",
  })
  const rightPanelModules = createMemo(() => [coreModule, missionsModule, integrationModule(), ...externalModules()])
  const extraStatusContent = createMemo(() => rightPanelModules().flatMap(module => module.renderStatusExtras ? [module.renderStatusExtras] : []))
  const allRightPanelTabs = createMemo(() => collectRightPanelItems<RightPanelTabModule>(rightPanelModules(), "tabs"))
  const visibleRightPanelTabs = createMemo(() =>
    applyRightPanelItemCustomization(
      allRightPanelTabs().filter(tab => extensionForTab(tab.id)?.enabled ?? true),
      rightPanelCustomization().tabOrder,
      // Addons have one profile-wide activation, not a second per-window visibility gate.
      rightPanelCustomization().hiddenTabIds.filter(id => !id.startsWith("extension:")),
    ),
  )
  const orderedRightPanelTabs = createMemo(() => applyRightPanelItemCustomization(allRightPanelTabs(), rightPanelCustomization().tabOrder, []))
  const extraStatusSections = createMemo(() => collectRightPanelItems<RightPanelSectionModule>(rightPanelModules(), "statusSections"))
  const allStatusSections = createMemo<RightPanelItem[]>(() => [...CORE_STATUS_SECTION_ITEMS, ...extraStatusSections()])
  const orderedStatusSections = createMemo(() => applyRightPanelItemCustomization(allStatusSections(), rightPanelCustomization().statusSectionOrder, []))
  const visibleStatusSections = createMemo(() =>
    applyRightPanelItemCustomization(
      allStatusSections(),
      rightPanelCustomization().statusSectionOrder,
      rightPanelCustomization().hiddenStatusSectionIds,
    ),
  )
  const activeRightPanelTab = createMemo(() => visibleRightPanelTabs().find((tab) => tab.id === rightPanelTab()) ?? visibleRightPanelTabs()[0])

  createEffect(() => {
    const active = activeRightPanelTab()
    if (active && active.id !== rightPanelTab()) {
      setRightPanelTab(active.id)
    }
  })

  return (
    <div id={props.panelId} class="relative flex flex-col h-full" ref={props.setContentEl}>
      <div class="panel-header right-panel-tab-bar">
        <div class="tab-container">
          <div class="panel-header-actions tab-strip-shortcuts">
            <IconButton
              ref={customizationTriggerRef}
              class="icon-toggle"
              size="small"
              color="inherit"
              aria-label={props.t("instanceShell.rightPanel.customize.toggle")}
              title={props.t("instanceShell.rightPanel.customize.toggle")}
              aria-expanded={rightPanelCustomizationOpen()}
              onClick={() => setRightPanelCustomizationOpen((open) => !open)}
            >
              <Settings2 class="h-4 w-4" />
            </IconButton>
          </div>
          <TabScroll>
              <div class="tab-strip-tabs" role="tablist" aria-label={props.t("instanceShell.rightPanel.tabs.ariaLabel")}>
                <DragDropProvider collisionDetector={closestCenter} onDragEnd={handleTabDragEnd}>
                  <DragDropSensors>
                    <SortableProvider ids={visibleRightPanelTabs().map((tab) => tab.id)}>
                      <For each={visibleRightPanelTabs()}>
                        {(tab) => (
                          <SortableRightPanelTab
                            tab={tab}
                            active={rightPanelTab() === tab.id}
                            tabId={tabId(tab.id)}
                            panelId={tabPanelId(tab.id)}
                            label={tab.label ?? props.t(tab.labelKey)}
                            dragTitle={props.t("instanceShell.rightPanel.customize.dragToReorder")}
                            tabIndex={rightPanelTab() === tab.id ? 0 : -1}
                            onSelect={() => setRightPanelTab(tab.id)}
                            onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                          />
                        )}
                      </For>
                    </SortableProvider>
                  </DragDropSensors>
                </DragDropProvider>
              </div>
          </TabScroll>
        </div>
      </div>

      <Show when={rightPanelCustomizationOpen()}>
        <RightPanelCustomizationPopover t={props.t} isActive={props.isActive} trigger={() => customizationTriggerRef}
          onClose={() => setRightPanelCustomizationOpen(false)} extensions={extensions} tabs={orderedRightPanelTabs}
          statusSections={orderedStatusSections} visibleStatusSectionCount={() => visibleStatusSections().length}
          customization={rightPanelCustomization} onCustomizationChange={updateRightPanelCustomization} />
      </Show>

      <div class="flex-1 overflow-y-auto">
        <Show keyed when={activeRightPanelTab()}>
          {(tab) => (
            <div id={tabPanelId(tab.id)} role="tabpanel" aria-labelledby={tabId(tab.id)} class="h-full min-h-0">
              <Suspense fallback={<RightPanelTabFallback />}>{tab.render()}</Suspense>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

export default RightPanel
