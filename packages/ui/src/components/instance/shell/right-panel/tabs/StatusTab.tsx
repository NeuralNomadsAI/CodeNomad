import { For, Show, createEffect, createMemo, on, type Accessor, type Component } from "solid-js"
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

import { ChevronDown, GripVertical, Info, Pencil, Trash2, XOctagon } from "lucide-solid"

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
import { ptyStore } from "../../../../../stores/ptys"
import { showConfirmDialog, showPromptDialog } from "../../../../../stores/alerts"

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
              <GripVertical class="h-3.5 w-3.5 text-tertiary" aria-hidden="true" />
              <span class="section-label">{props.t(props.section.labelKey)}</span>
            </span>
            <ChevronDown class={`right-panel-accordion-chevron ${props.expanded ? "right-panel-accordion-chevron-expanded" : ""}`} />
          </Accordion.Trigger>
          <Tooltip openDelay={200} gutter={4} placement="top">
            <Tooltip.Trigger as="button" type="button" class="section-info-trigger" aria-label={props.t(props.section.tooltipKey)}>
              <Info class="section-info-icon" />
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content class="section-info-tooltip">{props.t(props.section.tooltipKey)}</Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip>
        </Accordion.Header>
        <Accordion.Content class="right-panel-accordion-content">{props.section.render()}</Accordion.Content>
      </Accordion.Item>
    </div>
  )
}

const StatusTab: Component<StatusTabProps> = (props) => {
  const isSectionExpanded = (id: string) => props.expandedItems().includes(id)
  const ptyDirectory = createMemo(() => props.activeSession()?.location.directory ?? props.instance.folder)
  const ptyState = createMemo(() => ptyStore.getState(props.instanceId, ptyDirectory()))

  createEffect(on(
    () => [props.instanceId, ptyDirectory()] as const,
    ([instanceId, directory]) => void ptyStore.load(instanceId, directory),
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

  const renamePty = async (ptyId: string, currentTitle: string) => {
    const title = await showPromptDialog(props.t("instanceShell.backgroundProcesses.rename.message"), {
      title: props.t("instanceShell.backgroundProcesses.rename.title"),
      inputLabel: props.t("instanceShell.backgroundProcesses.rename.inputLabel"),
      inputDefaultValue: currentTitle,
      confirmLabel: props.t("instanceShell.backgroundProcesses.actions.rename"),
    })
    const trimmed = title?.trim()
    if (trimmed && trimmed !== currentTitle) {
      await ptyStore.updateTitle(props.instanceId, ptyDirectory(), ptyId, trimmed)
    }
  }

  const removePty = async (ptyId: string, title: string, running: boolean) => {
    const confirmed = await showConfirmDialog(
      props.t("instanceShell.backgroundProcesses.remove.message", { title }),
      {
        title: props.t("instanceShell.backgroundProcesses.remove.title"),
        confirmLabel: props.t(running
          ? "instanceShell.backgroundProcesses.actions.stopRemove"
          : "instanceShell.backgroundProcesses.actions.remove"),
      },
    )
    if (confirmed) await ptyStore.remove(props.instanceId, ptyDirectory(), ptyId)
  }

  const renderBackgroundProcesses = () => (
    <Show
      when={!ptyState().failed}
      fallback={<div class="right-panel-empty right-panel-empty--left"><span class="text-xs">{props.t("instanceShell.backgroundProcesses.error")}</span></div>}
    >
      <Show
        when={!ptyState().loading || ptyState().items.length > 0}
        fallback={<div class="right-panel-empty right-panel-empty--left"><span class="text-xs">{props.t("instanceShell.backgroundProcesses.loading")}</span></div>}
      >
        <Show
          when={ptyState().items.length > 0}
          fallback={<div class="right-panel-empty right-panel-empty--left"><span class="text-xs">{props.t("instanceShell.backgroundProcesses.empty")}</span></div>}
        >
          <div class="flex flex-col gap-2">
            <For each={ptyState().items}>
              {(pty) => {
                const running = () => pty.status === "running"
                return (
                  <article class="border border-base bg-surface-secondary px-3 py-2">
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0 flex-1">
                        <h4 class="truncate text-xs font-medium text-primary" title={pty.title}>{pty.title}</h4>
                        <code class="mt-1 block truncate text-xs text-secondary" title={[pty.command, ...pty.args].join(" ")}>
                          {[pty.command, ...pty.args].join(" ")}
                        </code>
                      </div>
                      <div class="flex shrink-0 gap-1">
                        <button
                          type="button"
                          class="button-tertiary inline-flex items-center justify-center p-1"
                          disabled={ptyState().loading}
                          onClick={() => void renamePty(pty.id, pty.title)}
                          aria-label={props.t("instanceShell.backgroundProcesses.actions.rename")}
                          title={props.t("instanceShell.backgroundProcesses.actions.rename")}
                        >
                          <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          class="button-tertiary inline-flex items-center justify-center p-1"
                          disabled={ptyState().loading}
                          onClick={() => void removePty(pty.id, pty.title, running())}
                          aria-label={props.t(running()
                            ? "instanceShell.backgroundProcesses.actions.stopRemove"
                            : "instanceShell.backgroundProcesses.actions.remove")}
                          title={props.t(running()
                            ? "instanceShell.backgroundProcesses.actions.stopRemove"
                            : "instanceShell.backgroundProcesses.actions.remove")}
                        >
                          <Show when={running()} fallback={<Trash2 class="h-3.5 w-3.5" aria-hidden="true" />}>
                            <XOctagon class="h-3.5 w-3.5" aria-hidden="true" />
                          </Show>
                        </button>
                      </div>
                    </div>
                    <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-tertiary">
                      <span>{props.t(`instanceShell.backgroundProcesses.status.${pty.status}`)}</span>
                      <span>{props.t("instanceShell.backgroundProcesses.pid", { pid: pty.pid })}</span>
                      <Show when={pty.exitCode !== undefined}>
                        <span>{props.t("instanceShell.backgroundProcesses.exitCode", { code: pty.exitCode })}</span>
                      </Show>
                    </div>
                    <div class="mt-1 truncate text-xs text-tertiary" title={pty.cwd}>{pty.cwd}</div>
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
      return <div class="text-xs text-tertiary">{props.t("providerUsage.noSession")}</div>
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
    </div>
  )
}

export default StatusTab
