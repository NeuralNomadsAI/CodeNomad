import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, untrack, type Accessor, type Component, type JSX } from "solid-js"
import type { LocationRef, ShellInfo } from "@opencode/client"
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
import SessionGoalLine from "../../../../session/session-goal-line"
import InstanceServiceStatus from "../../../../instance-service-status"
import { togglePermissionAutoAcceptForSession } from "../../../../../stores/instances"
import { isPermissionAutoAcceptEnabled } from "../../../../../stores/permission-auto-accept"
import { applyRightPanelItemCustomization, reorderStatusSections, type RightPanelCustomization, type RightPanelSectionModule } from "../registry"
import { createCoreStatusSectionManifest } from "../core-plugin"
import { shellStore } from "../../../../../stores/shells"
import { showConfirmDialog } from "../../../../../stores/alerts"
import { showToastNotification } from "../../../../../lib/notifications"
import { ShellOutputDialog } from "../../../../shell-output-dialog"
import { ProjectCapabilityBoundary } from "../../../../project-capability-gate"
import { getProjectAvailability } from "../../../../../stores/project-capability"
import { captureInstanceRequestAuthority } from "../../../../../stores/session-api"
import { statusSectionAvailable } from "./status-sections"

interface StatusTabProps {
  t: (key: string, vars?: Record<string, any>) => string

  instanceId: string
  instance: Instance

  activeSession: Accessor<Session | null>

  isActive: Accessor<boolean>
  expandedItems: Accessor<string[]>
  onExpandedItemsChange: (values: string[]) => void
  customization: Accessor<RightPanelCustomization>
  onCustomizationChange: (updater: (current: RightPanelCustomization) => RightPanelCustomization) => void
  extraSections?: readonly RightPanelSectionModule[]
  extraContent?: readonly (() => JSX.Element)[]
}

interface SortableStatusSectionProps {
  section: RightPanelSectionModule
  expanded: boolean
  t: (key: string, vars?: Record<string, any>) => string
}

const SortableStatusSection: Component<SortableStatusSectionProps> = (props) => {
  const sortable = createSortable(props.section.id)
  const regionLabelId = createUniqueId()
  const tooltip = () => props.section.tooltip ?? props.t(props.section.tooltipKey)
  return (
    <div ref={sortable} class={`right-panel-section-draggable ${sortable.isActiveDraggable ? "right-panel-section-draggable-active" : ""}`}
      data-status-section={props.section.id}>
      <Accordion.Item value={props.section.id} class="right-panel-accordion-item">
        <Accordion.Header class="right-panel-accordion-header-row">
          <Accordion.Trigger class="right-panel-accordion-trigger" data-status-section-trigger={props.section.id}>
            <span class="section-left">
              <ChevronRight class="right-panel-accordion-chevron disclosure-chevron" />
              <span class="section-label">{props.section.label ?? props.t(props.section.labelKey)}</span>
            </span>
            <Show when={props.section.renderStatus}>{(status) => status()()}</Show>
            <Show when={!props.expanded && props.section.renderSummary}>
              {(summary) => <span class="right-panel-section-summary">{summary()()}</span>}
            </Show>
          </Accordion.Trigger>
          <Show when={props.section.renderHeaderActions}>{(actions) => actions()()}</Show>
          <Show when={props.section.renderInfo} fallback={
            <Tooltip openDelay={200} gutter={4} placement="top">
              <Tooltip.Trigger as="button" type="button" class="section-info-trigger" aria-label={tooltip()}>
                <Info class="section-info-icon" />
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content class="section-info-tooltip">{tooltip()}</Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip>
          }>{(info) => info()()}</Show>
          <GripVertical class="right-panel-section-grip" aria-hidden="true" />
        </Accordion.Header>
        <Show when={props.section.regionLabel}>
          {(name) => <span id={regionLabelId} class="sr-only">{name()}</span>}
        </Show>
        <Accordion.Content class="right-panel-accordion-content" {...(props.section.regionLabel ? { "aria-labelledby": regionLabelId } : {})}>
          {props.section.render()}
        </Accordion.Content>
      </Accordion.Item>
    </div>
  )
}

const autoExpandedKeys = new WeakMap<Accessor<string[]>, Map<string, string>>()

const StatusTab: Component<StatusTabProps> = (props) => {
  let escaping = false
  const isSectionExpanded = (id: string) => props.expandedItems().includes(id)
  const shellLocation = createMemo(() => props.activeSession()?.location ?? { directory: props.instance.folder })
  const shellState = createMemo(() => shellStore.getState(props.instanceId, shellLocation().directory, shellLocation().workspaceID))
  const [outputShell, setOutputShell] = createSignal<{ shell: ShellInfo; location: LocationRef; instanceId: string } | null>(null)

  const ShellDemand = () => {
    createEffect(on(
      () => [props.instanceId, shellLocation().directory, shellLocation().workspaceID] as const,
      ([instanceId, directory, workspaceID]) => void shellStore.load(instanceId, directory, workspaceID),
    ))
    return renderBackgroundProcesses()
  }

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
            class="yolo-mode-switch"
            checked={isPermissionAutoAcceptEnabled(props.instanceId, session.id)}
            size="small"
            sx={{
              "& .MuiSwitch-switchBase.Mui-checked": { color: "var(--session-yolo-accent)" },
              "& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track": { backgroundColor: "var(--session-yolo-accent)" },
            }}
            inputProps={{ "aria-label": props.t("instanceShell.yoloMode.title") }}
            onChange={() => { if (getProjectAvailability(props.instanceId, "yolo").allowed) togglePermissionAutoAcceptForSession(props.instanceId, session.id) }}
          />
        </div>
      </div>
    )
  }

  const removeShell = async (shellId: string, command: string, running: boolean) => {
    if (!getProjectAvailability(props.instanceId, "backgroundShells").allowed) return
    const instanceId = props.instanceId
    const current = captureInstanceRequestAuthority(instanceId)
    const location = { ...shellLocation() }
    const confirmed = await showConfirmDialog(
      props.t("instanceShell.backgroundProcesses.remove.message", { title: command }),
      {
        title: props.t("instanceShell.backgroundProcesses.remove.title"),
        confirmLabel: props.t(running
          ? "instanceShell.backgroundProcesses.actions.stopRemove"
          : "instanceShell.backgroundProcesses.actions.remove"),
      },
    )
    if (!confirmed || !current() || !getProjectAvailability(instanceId, "backgroundShells").allowed) return
    const removed = await shellStore.remove(instanceId, location.directory, shellId, location.workspaceID)
    if (current() && getProjectAvailability(instanceId, "backgroundShells").allowed && !removed) {
      showToastNotification({ category: "sessions", message: props.t("instanceShell.backgroundProcesses.error"), variant: "error" })
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
          <div class="flex flex-col gap-1">
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
                    <div class="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-tertiary">
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
                         onClick={() => { if (getProjectAvailability(props.instanceId, "backgroundShells").allowed) setOutputShell({ shell, location: { ...shellLocation() }, instanceId: props.instanceId }) }}
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

  const renderProviderUsage = () => (
    <Show when={props.activeSession()} fallback={<div class="right-panel-empty-text">{props.t("providerUsage.noSession")}</div>}>
      {(session) => (
        <div class="border border-base bg-surface-secondary px-3 py-2">
          <ProviderUsagePanel instanceId={props.instanceId} sessionId={session().id} directory={session().location.directory}
            providerId={session().model.providerId} modelId={session().model.modelId}
            active={props.isActive() && props.expandedItems().includes("provider-usage")} />
        </div>
      )}
    </Show>
  )

  // Built once: a changed extra-section list must never recreate (remount) the core sections.
  const coreSections = untrack(() => createCoreStatusSectionManifest({
      renderTokens: () => (
        <Show when={props.activeSession()?.id}>
          <ContextUsagePanel instanceId={props.instanceId} sessionId={props.activeSession()!.id} />
        </Show>
      ),
      renderTokensSummary: () => (
        <Show when={props.activeSession()?.id}>
          <ContextUsagePanel instanceId={props.instanceId} sessionId={props.activeSession()!.id} summary />
        </Show>
      ),
      renderYoloModeSection: () => <ProjectCapabilityBoundary instanceId={props.instanceId} feature="yolo">{renderYoloModeSection()}</ProjectCapabilityBoundary>,
      renderProviderUsage: () => <ProjectCapabilityBoundary instanceId={props.instanceId} feature="providerUsage">{renderProviderUsage()}</ProjectCapabilityBoundary>,
      renderBackgroundProcesses: () => <ProjectCapabilityBoundary instanceId={props.instanceId} feature="backgroundShells"><ShellDemand /></ProjectCapabilityBoundary>,
      renderMcpStatus: () => <ProjectCapabilityBoundary instanceId={props.instanceId} feature="chat">
        <InstanceServiceStatus initialInstance={props.instance} sections={["mcp"]} showSectionHeadings={false} class="space-y-2" />
      </ProjectCapabilityBoundary>,
      renderPluginStatus: () => (
        <ProjectCapabilityBoundary instanceId={props.instanceId} feature="plugins">
        <InstanceServiceStatus
          initialInstance={props.instance}
          sections={["plugins"]}
          showSectionHeadings={false}
          pluginsActive={props.isActive() && isSectionExpanded("plugins")}
          class="space-y-2"
        />
        </ProjectCapabilityBoundary>
      ),
    }).statusSections ?? [])
  const allStatusSections = createMemo<RightPanelSectionModule[]>(() => [...coreSections, ...(props.extraSections ?? [])])
  const statusSections = createMemo<RightPanelSectionModule[]>(() =>
    applyRightPanelItemCustomization(
      allStatusSections().filter(section => statusSectionAvailable(props.instanceId, section.id)),
      props.customization().statusSectionOrder,
      props.customization().hiddenStatusSectionIds,
    ),
  )

  const moveSection = (sourceId: string, targetId: string) => {
    if (!sourceId || sourceId === targetId) return
    const ids = statusSections().map((section) => section.id)
    if (!ids.includes(sourceId) || !ids.includes(targetId)) return
    props.onCustomizationChange((current) => ({
      ...current,
      statusSectionOrder: reorderStatusSections(current.statusSectionOrder, ids, sourceId, targetId),
    }))
  }


  // An expected action expands its section once per key; a later user collapse holds until the key changes,
  // across the tab's remounts (the expanded set belongs to the panel).
  let autoExpanded = autoExpandedKeys.get(props.expandedItems)
  if (!autoExpanded) autoExpandedKeys.set(props.expandedItems, autoExpanded = new Map())
  createEffect(() => {
    const additions: string[] = []
    for (const section of allStatusSections()) {
      const key = section.autoExpandKey?.()
      if (key === null) continue
      if (!key) { autoExpanded!.delete(section.id); continue }
      if (autoExpanded!.get(section.id) === key) continue
      autoExpanded!.set(section.id, key)
      if (!untrack(props.expandedItems).includes(section.id)) additions.push(section.id)
    }
    if (additions.length) props.onExpandedItemsChange([...untrack(props.expandedItems), ...additions])
  })

  const handleSectionDragEnd = ({ draggable, droppable }: SolidDndDragEvent) => {
    if (!droppable) return
    moveSection(String(draggable.id), String(droppable.id))
  }

  return (
    <div class="status-tab-container">
      <Show when={getProjectAvailability(props.instanceId, "executionSettings").allowed && props.activeSession()?.id}>
        {(sessionId) => <SessionGoalLine instanceId={props.instanceId} sessionId={sessionId()} active={props.isActive()} />}
      </Show>
      <Accordion.Root
        class="right-panel-accordion"
        collapsible
        multiple
        value={props.expandedItems()}
        // Kobalte's list keyboard model clears every expanded item on Escape. Escape closes the popover,
        // tooltip or window it was meant for; it never collapses Status.
        onKeyDown={(event: KeyboardEvent) => {
          escaping = event.key === "Escape"
          if (escaping) queueMicrotask(() => { escaping = false })
        }}
        onChange={(values: string[]) => { if (!escaping) props.onExpandedItemsChange(values) }}
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
      <For each={props.extraContent ?? []}>{(render) => render()}</For>
      <Show when={getProjectAvailability(props.instanceId, "backgroundShells").allowed}><ShellOutputDialog
        open={Boolean(outputShell())}
        instanceId={outputShell()?.instanceId ?? props.instanceId}
        directory={outputShell()?.location.directory ?? shellLocation().directory}
        workspaceID={outputShell()?.location.workspaceID}
        shell={outputShell()?.shell ?? null}
        onClose={() => setOutputShell(null)}
      /></Show>
    </div>
  )
}

export default StatusTab
