import { For, Show, Suspense, createEffect, createMemo, createSignal, onCleanup, type Accessor, type Component } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk/v2"
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
import PushPinIcon from "@suid/icons-material/PushPin"
import PushPinOutlinedIcon from "@suid/icons-material/PushPinOutlined"
import { Settings2 } from "lucide-solid"

import type { Instance } from "../../../../types/instance"
import type { BackgroundProcess } from "../../../../../../server/src/api-types"
import type { Session } from "../../../../types/session"
import type { PromptInputApi } from "../../../prompt-input/types"
import type { DrawerViewState } from "../types"
import type { RightPanelTab } from "./types"

import { readClientLayoutValue, writeClientLayoutValue } from "../../../../stores/client-state"
import { RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY, RIGHT_PANEL_TAB_STORAGE_KEY, readStoredRightPanelTab } from "../storage"
import {
  applyRightPanelItemCustomization,
  collectRightPanelItems,
  parseRightPanelCustomization,
  setRightPanelItemHidden,
  type RightPanelCustomization,
  type RightPanelSectionModule,
  type RightPanelTabModule,
} from "./registry"
import { createCoreRightPanelRuntime } from "./core-runtime"
import { loadRightPanelPluginManifests } from "./plugin-manifest"
import { RIGHT_PANEL_PLUGIN_MANIFESTS } from "./plugins"
import { CORE_STATUS_SECTION_ITEMS } from "./tabs/status-sections"

function RightPanelTabFallback() {
  return <div class="flex-1 min-h-0" />
}

interface SortableRightPanelTabProps {
  tab: RightPanelTabModule
  active: boolean
  label: string
  dragTitle: string
  onSelect: () => void
}

const SortableRightPanelTab: Component<SortableRightPanelTabProps> = (props) => {
  const sortable = createSortable(props.tab.id)
  return (
    <div ref={sortable} class={`right-panel-tab-draggable ${sortable.isActiveDraggable ? "right-panel-tab-draggable-active" : ""}`}>
      <button
        type="button"
        role="tab"
        class={`right-panel-tab ${props.active ? "right-panel-tab-active" : "right-panel-tab-inactive"}`}
        aria-selected={props.active}
        title={props.dragTitle}
        onClick={props.onSelect}
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
  backgroundProcessList: Accessor<BackgroundProcess[]>
  onOpenBackgroundOutput: (process: BackgroundProcess) => void
  onStopBackgroundProcess: (processId: string) => Promise<void> | void
  onTerminateBackgroundProcess: (processId: string) => Promise<void> | void

  isPhoneLayout: Accessor<boolean>
  rightDrawerWidth: Accessor<number>
  rightDrawerWidthInitialized: Accessor<boolean>
  rightDrawerState: Accessor<DrawerViewState>
  rightPinned: Accessor<boolean>
  onCloseRightDrawer: () => void
  onPinRightDrawer: () => void
  onUnpinRightDrawer: () => void
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

  const rightPanelPluginRuntime = loadRightPanelPluginManifests(
    [
      createCoreRightPanelRuntime({
        t: props.t,
        instanceId: props.instanceId,
        instance: props.instance,
        activeSessionId: props.activeSessionId,
        activeSession: props.activeSession,
        latestTodoState: props.latestTodoState,
        backgroundProcessList: props.backgroundProcessList,
        onOpenBackgroundOutput: props.onOpenBackgroundOutput,
        onStopBackgroundProcess: props.onStopBackgroundProcess,
        onTerminateBackgroundProcess: props.onTerminateBackgroundProcess,
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
    { instanceId: props.instanceId },
  )
  onCleanup(() => {
    rightPanelPluginRuntime.unload()
  })

  const rightPanelModules = createMemo(() => rightPanelPluginRuntime.modules)
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
  const allStatusSections = createMemo(() => [...CORE_STATUS_SECTION_ITEMS, ...extraStatusSections()])
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
            <Show when={props.rightDrawerState() === "floating-open"}>
              <IconButton
                size="small"
                color="inherit"
                aria-label={props.t("instanceShell.rightDrawer.toggle.close")}
                title={props.t("instanceShell.rightDrawer.toggle.close")}
                onClick={props.onCloseRightDrawer}
              >
                <MenuOpenIcon fontSize="small" sx={{ transform: "scaleX(-1)" }} />
              </IconButton>
            </Show>
            <Show when={!props.isPhoneLayout()}>
              <IconButton
                size="small"
                color="inherit"
                aria-label={props.rightPinned() ? props.t("instanceShell.rightDrawer.unpin") : props.t("instanceShell.rightDrawer.pin")}
                onClick={() => (props.rightPinned() ? props.onUnpinRightDrawer() : props.onPinRightDrawer())}
              >
                {props.rightPinned() ? <PushPinIcon fontSize="small" /> : <PushPinOutlinedIcon fontSize="small" />}
              </IconButton>
            </Show>
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
                            label={props.t(tab.labelKey)}
                            dragTitle={props.t("instanceShell.rightPanel.customize.dragToReorder")}
                            onSelect={() => setRightPanelTab(tab.id)}
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
          <div class="right-panel-customization-header">
            <div>
              <div class="text-sm font-medium text-primary">{props.t("instanceShell.rightPanel.customize.title")}</div>
              <div class="text-xs text-secondary">{props.t("instanceShell.rightPanel.customize.description")}</div>
            </div>
            <button
              type="button"
              class="right-panel-customization-button"
              onClick={() => updateRightPanelCustomization(() => parseRightPanelCustomization(null))}
            >
              {props.t("instanceShell.rightPanel.customize.reset")}
            </button>
          </div>

          <div class="right-panel-customization-grid">
            <div class="right-panel-customization-group">
              <div class="right-panel-customization-group-title">{props.t("instanceShell.rightPanel.customize.tabs")}</div>
              <For each={orderedRightPanelTabs()}>
                {(tab) => {
                  const label = () => props.t(tab.labelKey)
                  const visible = () => !rightPanelCustomization().hiddenTabIds.includes(tab.id)
                  const disableHide = () => visible() && visibleRightPanelTabs().length <= 1
                  return (
                    <div class="right-panel-customization-row">
                      <label class="right-panel-customization-label">
                        <input
                          type="checkbox"
                          checked={visible()}
                          disabled={disableHide()}
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
                  )
                }}
              </For>
            </div>

            <div class="right-panel-customization-group">
              <div class="right-panel-customization-group-title">{props.t("instanceShell.rightPanel.customize.statusSections")}</div>
              <For each={orderedStatusSections()}>
                {(section) => {
                  const label = () => props.t(section.labelKey)
                  const visible = () => !rightPanelCustomization().hiddenStatusSectionIds.includes(section.id)
                  const disableHide = () => visible() && visibleStatusSections().length <= 1
                  return (
                    <div class="right-panel-customization-row">
                      <label class="right-panel-customization-label">
                        <input
                          type="checkbox"
                          checked={visible()}
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
                        <span>{label()}</span>
                      </label>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
          <div class="right-panel-customization-hint">{props.t("instanceShell.rightPanel.customize.dragToReorder")}</div>
        </div>
      </Show>

      <div class="flex-1 overflow-y-auto">
        <Show keyed when={activeRightPanelTab()}>
          {(tab) => <Suspense fallback={<RightPanelTabFallback />}>{tab.render()}</Suspense>}
        </Show>
      </div>
    </div>
  )
}

export default RightPanel
