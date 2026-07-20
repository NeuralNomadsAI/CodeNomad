import { For, Show, createMemo, createSignal, type Accessor, type Component } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk/v2"
import { Accordion } from "@kobalte/core"
import { Tooltip } from "@kobalte/core/tooltip"
import Switch from "@suid/material/Switch"

import { BellRing, ChevronDown, GripVertical, Info, TerminalSquare, Trash2, XOctagon } from "lucide-solid"

import type { Instance } from "../../../../../types/instance"
import type { BackgroundProcess } from "../../../../../../../server/src/api-types"
import type { Session } from "../../../../../types/session"

import ContextUsagePanel from "../../../../session/context-usage-panel"
import ProviderUsagePanel from "../../../../session/provider-usage-panel"
import { TodoListView } from "../../../../tool-call/renderers/todo"
import InstanceServiceStatus from "../../../../instance-service-status"
import { togglePermissionAutoAcceptForSession } from "../../../../../stores/instances"
import { isPermissionAutoAcceptEnabled } from "../../../../../stores/permission-auto-accept"
import { applyRightPanelItemCustomization, type RightPanelCustomization, type RightPanelSectionModule } from "../registry"

interface StatusTabProps {
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

  expandedItems: Accessor<string[]>
  onExpandedItemsChange: (values: string[]) => void
  customization: Accessor<RightPanelCustomization>
  onCustomizationChange: (updater: (current: RightPanelCustomization) => RightPanelCustomization) => void
  extraSections?: readonly RightPanelSectionModule[]
}

const StatusTab: Component<StatusTabProps> = (props) => {
  const isSectionExpanded = (id: string) => props.expandedItems().includes(id)
  const [draggedSectionId, setDraggedSectionId] = createSignal<string | null>(null)

  const renderYoloModeSection = () => {
    const session = props.activeSession()
    if (!session) {
      return (
        <div class="right-panel-empty right-panel-empty--left">
          <span class="text-xs">{props.t("instanceShell.yoloMode.noSessionSelected")}</span>
        </div>
      )
    }

    return (
      <div class="flex items-center justify-between gap-2 border border-base bg-surface-secondary px-3 py-2">
        <p class="min-w-0 text-xs leading-5 text-secondary">{props.t("instanceShell.yoloMode.description")}</p>
        <div class="-mr-2 shrink-0">
          <Switch
            checked={isPermissionAutoAcceptEnabled(props.instanceId, session.id)}
            color="warning"
            size="small"
            inputProps={{ "aria-label": props.t("instanceShell.yoloMode.title") }}
            onChange={() => togglePermissionAutoAcceptForSession(props.instanceId, session.id)}
          />
        </div>
      </div>
    )
  }

  const renderPlanSectionContent = () => {
    const sessionId = props.activeSessionId()
    if (!sessionId || sessionId === "info") {
      return (
        <div class="right-panel-empty right-panel-empty--left">
          <span class="text-xs">{props.t("instanceShell.plan.noSessionSelected")}</span>
        </div>
      )
    }
    const todoState = props.latestTodoState()
    if (!todoState) {
      return (
        <div class="right-panel-empty right-panel-empty--left">
          <span class="text-xs">{props.t("instanceShell.plan.empty")}</span>
        </div>
      )
    }
    return <TodoListView state={todoState} emptyLabel={props.t("instanceShell.plan.empty")} showStatusLabel={false} />
  }

  const renderBackgroundProcesses = () => {
    const processes = props.backgroundProcessList()
    if (processes.length === 0) {
      return (
        <div class="right-panel-empty right-panel-empty--left">
          <span class="text-xs">{props.t("instanceShell.backgroundProcesses.empty")}</span>
        </div>
      )
    }

    return (
      <div class="flex flex-col gap-2">
        <For each={processes}>
          {(process) => (
            <div class="status-process-card">
              <div class="status-process-header">
                <span class="status-process-title">{process.title}</span>
                <div class="status-process-meta">
                  <span
                    classList={{
                      "text-success": Boolean(process.notifyEnabled),
                      "text-tertiary": !process.notifyEnabled,
                    }}
                    aria-label={props.t(
                      process.notifyEnabled
                        ? "instanceShell.backgroundProcesses.notify.enabled"
                        : "instanceShell.backgroundProcesses.notify.disabled",
                    )}
                    title={props.t(
                      process.notifyEnabled
                        ? "instanceShell.backgroundProcesses.notify.enabled"
                        : "instanceShell.backgroundProcesses.notify.disabled",
                    )}
                  >
                    <BellRing class="h-3.5 w-3.5" />
                  </span>
                  <span>{props.t("instanceShell.backgroundProcesses.status", { status: process.status })}</span>
                  <Show when={typeof process.outputSizeBytes === "number"}>
                    <span>
                      {props.t("instanceShell.backgroundProcesses.output", {
                        sizeKb: Math.round((process.outputSizeBytes ?? 0) / 1024),
                      })}
                    </span>
                  </Show>
                </div>
              </div>
              <div class="status-process-actions">
                <button
                  type="button"
                  class="button-tertiary w-full p-1 inline-flex items-center justify-center"
                  onClick={() => props.onOpenBackgroundOutput(process)}
                  aria-label={props.t("instanceShell.backgroundProcesses.actions.output")}
                  title={props.t("instanceShell.backgroundProcesses.actions.output")}
                >
                  <TerminalSquare class="h-4 w-4" />
                </button>
                <button
                  type="button"
                  class="button-tertiary w-full p-1 inline-flex items-center justify-center"
                  disabled={process.status !== "running"}
                  onClick={() => props.onStopBackgroundProcess(process.id)}
                  aria-label={props.t("instanceShell.backgroundProcesses.actions.stop")}
                  title={props.t("instanceShell.backgroundProcesses.actions.stop")}
                >
                  <XOctagon class="h-4 w-4" />
                </button>
                <button
                  type="button"
                  class="button-tertiary w-full p-1 inline-flex items-center justify-center"
                  onClick={() => props.onTerminateBackgroundProcess(process.id)}
                  aria-label={props.t("instanceShell.backgroundProcesses.actions.terminate")}
                  title={props.t("instanceShell.backgroundProcesses.actions.terminate")}
                >
                  <Trash2 class="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    )
  }

  const renderProviderUsage = () => {
    const session = props.activeSession()
    if (!session) {
      return <div class="text-xs text-tertiary">{props.t("providerUsage.noSession")}</div>
    }
    return (
      <div class="border border-base bg-surface-secondary px-3 py-2">
        <ProviderUsagePanel providerId={session.model.providerId} modelId={session.model.modelId} />
      </div>
    )
  }

  const statusSections = createMemo<RightPanelSectionModule[]>(() => {
    const sections: RightPanelSectionModule[] = [
      {
        id: "provider-usage",
        labelKey: "providerUsage.title",
        tooltipKey: "providerUsage.tooltip",
        order: 10,
        render: renderProviderUsage,
      },
      {
        id: "yolo-mode",
        labelKey: "instanceShell.rightPanel.sections.yoloMode",
        tooltipKey: "instanceShell.rightPanel.sections.yoloMode.tooltip",
        order: 20,
        render: renderYoloModeSection,
      },
      {
        id: "plan",
        labelKey: "instanceShell.rightPanel.sections.plan",
        tooltipKey: "instanceShell.rightPanel.sections.plan.tooltip",
        order: 30,
        render: renderPlanSectionContent,
      },
      {
        id: "background-processes",
        labelKey: "instanceShell.rightPanel.sections.backgroundProcesses",
        tooltipKey: "instanceShell.rightPanel.sections.backgroundProcesses.tooltip",
        order: 40,
        render: renderBackgroundProcesses,
      },
      {
        id: "mcp",
        labelKey: "instanceShell.rightPanel.sections.mcp",
        tooltipKey: "instanceShell.rightPanel.sections.mcp.tooltip",
        order: 50,
        render: () => <InstanceServiceStatus initialInstance={props.instance} sections={["mcp"]} showSectionHeadings={false} class="space-y-2" />,
      },
      {
        id: "lsp",
        labelKey: "instanceShell.rightPanel.sections.lsp",
        tooltipKey: "instanceShell.rightPanel.sections.lsp.tooltip",
        order: 60,
        render: () => <InstanceServiceStatus initialInstance={props.instance} sections={["lsp"]} showSectionHeadings={false} class="space-y-2" />,
      },
      {
        id: "plugins",
        labelKey: "instanceShell.rightPanel.sections.plugins",
        tooltipKey: "instanceShell.rightPanel.sections.plugins.tooltip",
        order: 70,
        render: () => (
          <InstanceServiceStatus initialInstance={props.instance} sections={["plugins"]} showSectionHeadings={false} class="space-y-2" />
        ),
      },
    ]
    return applyRightPanelItemCustomization(
      [...sections, ...(props.extraSections ?? [])],
      props.customization().statusSectionOrder,
      props.customization().hiddenStatusSectionIds,
    )
  })

  const moveSection = (sourceId: string, targetId: string) => {
    if (!sourceId || sourceId === targetId) return
    const ids = statusSections().map((section) => section.id)
    const sourceIndex = ids.indexOf(sourceId)
    const targetIndex = ids.indexOf(targetId)
    if (sourceIndex === -1 || targetIndex === -1) return
    const next = [...ids]
    const [moved] = next.splice(sourceIndex, 1)
    next.splice(targetIndex, 0, moved)
    props.onCustomizationChange((current) => ({ ...current, statusSectionOrder: next }))
  }

  return (
    <div class="status-tab-container">
      <Show when={props.activeSession()}>
        {(activeSession) => (
          <ContextUsagePanel instanceId={props.instanceId} sessionId={activeSession().id} class="status-tab-context-panel" />
        )}
      </Show>

      <Accordion.Root
        class="right-panel-accordion"
        collapsible
        multiple
        value={props.expandedItems()}
        onChange={props.onExpandedItemsChange}
      >
        <For each={statusSections()}>
          {(section) => (
            <Accordion.Item
              value={section.id}
              class="right-panel-accordion-item"
              draggable
              onDragStart={(event) => {
                setDraggedSectionId(section.id)
                event.dataTransfer?.setData("text/plain", section.id)
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
              }}
              onDragOver={(event) => {
                if (!draggedSectionId() || draggedSectionId() === section.id) return
                event.preventDefault()
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
              }}
              onDrop={(event) => {
                event.preventDefault()
                const sourceId = event.dataTransfer?.getData("text/plain") || draggedSectionId()
                if (sourceId) moveSection(sourceId, section.id)
                setDraggedSectionId(null)
              }}
              onDragEnd={() => setDraggedSectionId(null)}
            >
              <Accordion.Header class="right-panel-accordion-header-row">
                <Accordion.Trigger class="right-panel-accordion-trigger">
                  <span class="section-left">
                    <GripVertical class="h-3.5 w-3.5 text-tertiary" aria-hidden="true" />
                    <span class="section-label">{props.t(section.labelKey)}</span>
                  </span>
                  <ChevronDown
                    class={`right-panel-accordion-chevron ${isSectionExpanded(section.id) ? "right-panel-accordion-chevron-expanded" : ""}`}
                  />
                </Accordion.Trigger>
                <Tooltip openDelay={200} gutter={4} placement="top">
                  <Tooltip.Trigger as="button" type="button" class="section-info-trigger" aria-label={props.t(section.tooltipKey)}>
                    <Info class="section-info-icon" />
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content class="section-info-tooltip">{props.t(section.tooltipKey)}</Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip>
              </Accordion.Header>
              <Accordion.Content class="right-panel-accordion-content">{section.render()}</Accordion.Content>
            </Accordion.Item>
          )}
        </For>
      </Accordion.Root>
    </div>
  )
}

export default StatusTab
