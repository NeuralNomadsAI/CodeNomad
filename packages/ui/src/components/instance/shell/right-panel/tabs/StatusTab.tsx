import { For, Show, createEffect, createMemo, createSignal, on, type Accessor, type Component } from "solid-js"
import type { ShellInfo } from "@opencode-ai/client"
import type { ToolState } from "../../../../../types/tool-state"
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
  createSortable,
  type DragEvent as SolidDndDragEvent,
} from "@thisbeyond/solid-dnd"
import { Accordion } from "@kobalte/core"
import { Tooltip } from "@kobalte/core/tooltip"
import Switch from "@suid/material/Switch"

import { ChevronRight, GripVertical, Info, TerminalSquare, Trash2, XOctagon } from "lucide-solid"

import type { Instance } from "../../../../../types/instance"
import type { Session } from "../../../../../types/session"

import ContextUsagePanel from "../../../../session/context-usage-panel"
import ProviderUsagePanel from "../../../../session/provider-usage-panel"
import { TodoListView } from "../../../../tool-call/renderers/todo"
import InstanceServiceStatus from "../../../../instance-service-status"
import { togglePermissionAutoAcceptForSession } from "../../../../../stores/instances"
import { isPermissionAutoAcceptEnabled } from "../../../../../stores/permission-auto-accept"
import { applyRightPanelItemCustomization, type RightPanelCustomization, type RightPanelSectionModule } from "../registry"
import { createCoreStatusSectionManifest } from "../core-plugin"
import { shellStore } from "../../../../../stores/shells"
import { showConfirmDialog } from "../../../../../stores/alerts"
import { showToastNotification } from "../../../../../lib/notifications"
import { ShellOutputDialog } from "../../../../shell-output-dialog"

interface StatusTabProps {
  t: (key: string, vars?: Record<string, any>) => string

  instanceId: string
  instance: Instance

  activeSessionId: Accessor<string | null>
  activeSession: Accessor<Session | null>

  latestTodoState: Accessor<ToolState | null>

  expandedItems: Accessor<string[]>
  onExpandedItemsChange: (values: string[]) => void
  customization: Accessor<RightPanelCustomization>
  onCustomizationChange: (updater: (current: RightPanelCustomization) => RightPanelCustomization) => void
  extraSections?: readonly RightPanelSectionModule[]
}

interface SortableStatusSectionProps {
  section: RightPanelSectionModule
  expanded: boolean
  t: (key: string, vars?: Record<string, any>) => string
}

const SortableStatusSection: Component<SortableStatusSectionProps> = (props) => {
  const sortable = createSortable(props.section.id)
  return (
    <div ref={sortable} class={`right-panel-section-draggable ${sortable.isActiveDraggable ? "right-panel-section-draggable-active" : ""}`}>
      <Accordion.Item value={props.section.id} class="right-panel-accordion-item">
        <Accordion.Header class="right-panel-accordion-header-row">
          <Accordion.Trigger class="right-panel-accordion-trigger">
            <span class="section-left">
              <ChevronRight class="right-panel-accordion-chevron disclosure-chevron" />
              <span class="section-label">{props.t(props.section.labelKey)}</span>
            </span>
          </Accordion.Trigger>
          <Tooltip openDelay={200} gutter={4} placement="top">
            <Tooltip.Trigger as="button" type="button" class="section-info-trigger" aria-label={props.t(props.section.tooltipKey)}>
              <Info class="section-info-icon" />
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content class="section-info-tooltip">{props.t(props.section.tooltipKey)}</Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip>
          <GripVertical class="right-panel-section-grip" aria-hidden="true" />
        </Accordion.Header>
        <Accordion.Content class="right-panel-accordion-content">{props.section.render()}</Accordion.Content>
      </Accordion.Item>
    </div>
  )
}

const StatusTab: Component<StatusTabProps> = (props) => {
  const isSectionExpanded = (id: string) => props.expandedItems().includes(id)
  const shellDirectory = createMemo(() => props.activeSession()?.location.directory ?? props.instance.folder)
  const shellState = createMemo(() => shellStore.getState(props.instanceId, shellDirectory()))
  const [outputShell, setOutputShell] = createSignal<ShellInfo | null>(null)

  createEffect(on(
    () => [props.instanceId, shellDirectory()] as const,
    ([instanceId, directory]) => void shellStore.load(instanceId, directory),
  ))

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

  const removeShell = async (shellId: string, command: string, running: boolean) => {
    const confirmed = await showConfirmDialog(
      props.t("instanceShell.backgroundProcesses.remove.message", { title: command }),
      {
        title: props.t("instanceShell.backgroundProcesses.remove.title"),
        confirmLabel: props.t(running
          ? "instanceShell.backgroundProcesses.actions.stopRemove"
          : "instanceShell.backgroundProcesses.actions.remove"),
      },
    )
    if (confirmed && !await shellStore.remove(props.instanceId, shellDirectory(), shellId)) {
      showToastNotification({ message: props.t("instanceShell.backgroundProcesses.error"), variant: "error" })
    }
  }

  const renderBackgroundProcesses = () => (
    <Show
      when={!shellState().failed}
      fallback={<div class="right-panel-empty right-panel-empty--left"><span class="text-xs">{props.t("instanceShell.backgroundProcesses.error")}</span></div>}
    >
      <Show
        when={!shellState().loading || shellState().items.length > 0}
        fallback={<div class="right-panel-empty right-panel-empty--left"><span class="text-xs">{props.t("instanceShell.backgroundProcesses.loading")}</span></div>}
      >
        <Show
          when={shellState().items.length > 0}
          fallback={<div class="right-panel-empty right-panel-empty--left"><span class="text-xs">{props.t("instanceShell.backgroundProcesses.empty")}</span></div>}
        >
          <div class="flex flex-col gap-2">
            <For each={shellState().items}>
              {(shell) => {
                const running = () => shell.status === "running"
                return (
                  <article class="status-process-card">
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0 flex-1">
                        <h4 class="truncate text-xs font-medium text-primary" title={shell.command}>{shell.command}</h4>
                        <code class="mt-1 block truncate text-xs text-secondary" title={shell.shell}>{shell.shell}</code>
                      </div>
                    </div>
                    <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-tertiary">
                      <span>{props.t(`instanceShell.backgroundProcesses.status.${shell.status}`)}</span>
                      <Show when={shell.pid !== undefined}>
                        <span>{props.t("instanceShell.backgroundProcesses.pid", { pid: shell.pid })}</span>
                      </Show>
                      <Show when={shell.exit !== undefined}>
                        <span>{props.t("instanceShell.backgroundProcesses.exitCode", { code: shell.exit })}</span>
                      </Show>
                    </div>
                    <div class="mt-1 truncate text-xs text-tertiary" title={shell.cwd}>{shell.cwd}</div>
                    <div class="status-process-actions">
                      <button
                        type="button"
                        class="button-tertiary inline-flex w-full items-center justify-center gap-1 p-1"
                        onClick={() => setOutputShell(shell)}
                      >
                        <TerminalSquare class="h-3.5 w-3.5" aria-hidden="true" />
                        {props.t("instanceShell.backgroundProcesses.actions.output")}
                      </button>
                      <button
                        type="button"
                        class="button-tertiary inline-flex w-full items-center justify-center gap-1 p-1"
                        disabled={shellState().loading}
                        onClick={() => void removeShell(shell.id, shell.command, running())}
                      >
                        <Show when={running()} fallback={<Trash2 class="h-3.5 w-3.5" aria-hidden="true" />}>
                          <XOctagon class="h-3.5 w-3.5" aria-hidden="true" />
                        </Show>
                        {props.t(running()
                          ? "instanceShell.backgroundProcesses.actions.stopRemove"
                          : "instanceShell.backgroundProcesses.actions.remove")}
                      </button>
                    </div>
                  </article>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </Show>
  )

  const renderProviderUsage = () => {
    const session = props.activeSession()
    if (!session) {
      return <div class="right-panel-empty-text">{props.t("providerUsage.noSession")}</div>
    }
    return (
      <div class="border border-base bg-surface-secondary px-3 py-2">
        <ProviderUsagePanel providerId={session.model.providerId} modelId={session.model.modelId} />
      </div>
    )
  }

  const allStatusSections = createMemo<RightPanelSectionModule[]>(() => {
    const sections = createCoreStatusSectionManifest({
      renderYoloModeSection,
      renderProviderUsage,
      renderPlanSectionContent,
      renderBackgroundProcesses,
      renderMcpStatus: () => <InstanceServiceStatus initialInstance={props.instance} sections={["mcp"]} showSectionHeadings={false} class="space-y-2" />,
      renderPluginStatus: () => (
        <InstanceServiceStatus initialInstance={props.instance} sections={["plugins"]} showSectionHeadings={false} class="space-y-2" />
      ),
    }).statusSections ?? []

    return [...sections, ...(props.extraSections ?? [])]
  })
  const statusSections = createMemo<RightPanelSectionModule[]>(() =>
    applyRightPanelItemCustomization(
      allStatusSections(),
      props.customization().statusSectionOrder,
      props.customization().hiddenStatusSectionIds,
    ),
  )

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

  const handleSectionDragEnd = ({ draggable, droppable }: SolidDndDragEvent) => {
    if (!droppable) return
    moveSection(String(draggable.id), String(droppable.id))
  }

  return (
    <div class="status-tab-container">
      <Show when={props.activeSession()?.id}>
        <ContextUsagePanel instanceId={props.instanceId} sessionId={props.activeSession()!.id} class="status-tab-context-panel" />
      </Show>

      <Accordion.Root
        class="right-panel-accordion"
        collapsible
        multiple
        value={props.expandedItems()}
        onChange={props.onExpandedItemsChange}
      >
        <DragDropProvider collisionDetector={closestCenter} onDragEnd={handleSectionDragEnd}>
          <DragDropSensors>
            <SortableProvider ids={statusSections().map((section) => section.id)}>
              <For each={statusSections()}>
                {(section) => <SortableStatusSection section={section} expanded={isSectionExpanded(section.id)} t={props.t} />}
              </For>
            </SortableProvider>
          </DragDropSensors>
        </DragDropProvider>
      </Accordion.Root>
      <ShellOutputDialog
        open={Boolean(outputShell())}
        instanceId={props.instanceId}
        directory={shellDirectory()}
        shell={outputShell()}
        onClose={() => setOutputShell(null)}
      />
    </div>
  )
}

export default StatusTab
