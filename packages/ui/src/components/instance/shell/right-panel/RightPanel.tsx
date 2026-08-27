import { For, Show, Suspense, createEffect, createMemo, createSignal, createUniqueId, type Accessor, type Component } from "solid-js"
import type { ToolState } from "../../../../types/tool-state"
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
  createSortable,
  type DragEvent as SolidDndDragEvent,
} from "@thisbeyond/solid-dnd"
import IconButton from "@suid/material/IconButton"
import MenuOpenIcon from "@suid/icons-material/MenuOpen"
import { Settings2 } from "lucide-solid"

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
  setRightPanelItemHidden,
  type RightPanelCustomization,
  type RightPanelItem,
  type RightPanelSectionModule,
  type RightPanelTabModule,
} from "./registry"
import { createCoreRightPanelRuntime } from "./core-runtime"
import { loadRightPanelPluginManifests, type RightPanelPluginLoadError } from "./plugin-manifest"
import { RIGHT_PANEL_PLUGIN_MANIFESTS } from "./plugins"
import { CORE_STATUS_SECTION_ITEMS } from "./tabs/status-sections"

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
  t: (key: string, vars?: Record<string, any>) => string

  instanceId: string
  instance: Instance

  activeSessionId: Accessor<string | null>
  activeSession: Accessor<Session | null>

  latestTodoState: Accessor<ToolState | null>

  isPhoneLayout: Accessor<boolean>
  rightDrawerWidth: Accessor<number>
  rightDrawerWidthInitialized: Accessor<boolean>
  onCloseRightDrawer: () => void
  promptInputApi: Accessor<PromptInputApi | null>

  setContentEl: (el: HTMLElement | null) => void
}

const RightPanel: Component<RightPanelProps> = (props) => {
  const [rightPanelTab, setRightPanelTab] = createSignal<RightPanelTab>(readStoredRightPanelTab("git-changes"))
  const defaultStatusSectionIds = CORE_STATUS_SECTION_ITEMS.map((section) => section.id)
  const [rightPanelExpandedItems, setRightPanelExpandedItems] = createSignal<string[]>(defaultStatusSectionIds)
  const [rightPanelCustomizationOpen, setRightPanelCustomizationOpen] = createSignal(false)
  const [rightPanelCustomization, setRightPanelCustomization] = createSignal<RightPanelCustomization>(
    parseRightPanelCustomization(readClientLayoutValue(RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY)),
  )
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

  const openRightPanelTab = (tabId: string) => {
    updateRightPanelCustomization((current) => ({
      ...current,
      hiddenTabIds: current.hiddenTabIds.filter((id) => id !== tabId),
    }))
    setRightPanelTab(tabId)
  }

  const handleTabKeyDown = (event: KeyboardEvent, currentTabId: string) => {
    const tabs = visibleRightPanelTabs()
    const index = tabs.findIndex((tab) => tab.id === currentTabId)
    if (index === -1) return

    let target: RightPanelTabModule | undefined
    if (event.key === "ArrowLeft") target = tabs[(index - 1 + tabs.length) % tabs.length]
    if (event.key === "ArrowRight") target = tabs[(index + 1) % tabs.length]
    if (event.key === "Home") target = tabs[0]
    if (event.key === "End") target = tabs[tabs.length - 1]
    if (!target) return

    event.preventDefault()
    setRightPanelTab(target.id)
    queueMicrotask(() => document.getElementById(tabId(target.id))?.focus())
  }

  const rightPanelPluginRuntime = loadRightPanelPluginManifests(
    [
      createCoreRightPanelRuntime({
        t: props.t,
        instanceId: props.instanceId,
        instance: props.instance,
        activeSessionId: props.activeSessionId,
        activeSession: props.activeSession,
        latestTodoState: props.latestTodoState,
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
      }),
      ...RIGHT_PANEL_PLUGIN_MANIFESTS,
    ],
    {
      instanceId: props.instanceId,
      t: props.t,
      activeSessionId: props.activeSessionId,
      isTabActive: (tabId) => rightPanelTab() === tabId,
      openTab: openRightPanelTab,
      reportAttention: () => undefined,
    },
  )

  const rightPanelModules = createMemo(() => rightPanelPluginRuntime.modules)
  const rightPanelPluginErrors = createMemo(() => rightPanelPluginRuntime.errors)
  const allRightPanelTabs = createMemo(() => collectRightPanelItems<RightPanelTabModule>(rightPanelModules(), "tabs"))
  const visibleRightPanelTabs = createMemo(() =>
    applyRightPanelItemCustomization(
      allRightPanelTabs(),
      rightPanelCustomization().tabOrder,
      rightPanelCustomization().hiddenTabIds,
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
    <div class="relative flex flex-col h-full" ref={props.setContentEl}>
      <div class="right-panel-tab-bar">
        <div class="tab-container">
          <div class="tab-strip-shortcuts text-primary">
            <IconButton
              size="small"
              color="inherit"
              aria-label={props.t("instanceShell.rightDrawer.toggle.close")}
              title={props.t("instanceShell.rightDrawer.toggle.close")}
              onClick={props.onCloseRightDrawer}
            >
              <MenuOpenIcon fontSize="small" sx={{ transform: "scaleX(-1)" }} />
            </IconButton>
            <IconButton
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
          <div class="tab-scroll">
            <div class="tab-strip">
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
                            label={props.t(tab.labelKey)}
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

              <div class="tab-strip-spacer" />
            </div>
          </div>
        </div>
      </div>

      <Show when={rightPanelCustomizationOpen()}>
        <div class="right-panel-customization-popover" role="dialog" aria-label={props.t("instanceShell.rightPanel.customize.title")}>
          <div class="right-panel-customization-grid">
            <For each={orderedRightPanelTabs()}>
              {(tab) => {
                const label = () => props.t(tab.labelKey)
                const visible = () => tab.alwaysVisible || !rightPanelCustomization().hiddenTabIds.includes(tab.id)
                return (
                  <>
                    <div class="right-panel-customization-row">
                      <label class="right-panel-customization-label">
                        <input
                          type="checkbox"
                          checked={visible()}
                          disabled={tab.alwaysVisible}
                          onChange={(event) =>
                            updateRightPanelCustomization((current) => ({
                              ...current,
                              hiddenTabIds: setRightPanelItemHidden(current.hiddenTabIds, tab.id, !event.currentTarget.checked),
                            }))
                          }
                        />
                        <span>{label()}</span>
                      </label>
                    </div>
                    <Show when={tab.id === "status"}>
                      <For each={orderedStatusSections()}>
                        {(section) => {
                          const sectionLabel = () => props.t(section.labelKey)
                          const sectionVisible = () => !rightPanelCustomization().hiddenStatusSectionIds.includes(section.id)
                          const disableHide = () => sectionVisible() && visibleStatusSections().length <= 1
                          return (
                            <div class="right-panel-customization-row right-panel-customization-row-indent">
                              <label class="right-panel-customization-label">
                                <input
                                  type="checkbox"
                                  checked={sectionVisible()}
                                  disabled={disableHide()}
                                  onChange={(event) =>
                                    updateRightPanelCustomization((current) => ({
                                      ...current,
                                      hiddenStatusSectionIds: setRightPanelItemHidden(
                                        current.hiddenStatusSectionIds,
                                        section.id,
                                        !event.currentTarget.checked,
                                      ),
                                    }))
                                  }
                                />
                                <span>{sectionLabel()}</span>
                              </label>
                            </div>
                          )
                        }}
                      </For>
                    </Show>
                  </>
                )
              }}
            </For>

            <Show when={rightPanelPluginErrors().length > 0}>
              <For each={rightPanelPluginErrors()}>
                {(error: RightPanelPluginLoadError) => (
                  <div class="right-panel-customization-row">
                    <span class="right-panel-customization-label">
                      {props.t("instanceShell.rightPanel.customize.moduleUnavailable", {
                        module: error.displayNameKey ? props.t(error.displayNameKey) : error.pluginId,
                      })}
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>
          <button
            type="button"
            class="right-panel-customization-button mt-2 w-full"
            onClick={() => updateRightPanelCustomization(() => parseRightPanelCustomization(null))}
          >
            {props.t("instanceShell.rightPanel.customize.reset")}
          </button>
        </div>
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
