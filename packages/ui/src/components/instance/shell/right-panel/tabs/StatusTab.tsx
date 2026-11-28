import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, untrack, type Accessor, type Component, type JSX } from "solid-js"
import type { LocationRef, ShellInfo } from "@opencode/client"
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
  createSortable,
  transformStyle,
  type DragEvent as SolidDndDragEvent,
} from "@thisbeyond/solid-dnd"
import { Accordion } from "@kobalte/core"
import { Tooltip } from "@kobalte/core/tooltip"

import { ChevronRight, GripVertical, Info } from "lucide-solid"

import type { Instance } from "../../../../../types/instance"
import type { Session } from "../../../../../types/session"

import ContextUsagePanel from "../../../../session/context-usage-panel"
import ProviderUsagePanel from "../../../../session/provider-usage-panel"
import SessionGoalLine from "../../../../session/session-goal-line"
import SessionAutomationsBlock from "../../../../session/session-automations-block"
import { ConversationPermissions, ConversationPermissionsInfo, ConversationPermissionsSummary, createConversationPermissionsState } from "../../../../session/conversation-permissions"
import InstanceServiceStatus from "../../../../instance-service-status"
import { applyRightPanelItemCustomization, CONVERSATION_PERMISSIONS_SECTION_ID, reorderStatusSections, type RightPanelCustomization, type RightPanelSectionModule } from "../registry"
import { createCoreStatusSectionManifest } from "../core-plugin"
import { shellStore } from "../../../../../stores/shells"
import { showConfirmDialog } from "../../../../../stores/alerts"
import { showToastNotification } from "../../../../../lib/notifications"
import { ShellOutputDialog } from "../../../../shell-output-dialog"
import { BackgroundShellRow } from "../../../../background-shell-row"

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
    <div ref={sortable.ref} class={`right-panel-section-draggable ${sortable.isActiveDraggable ? "right-panel-section-draggable-active" : ""}`}
      style={transformStyle(sortable.transform)}
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
          <span class="right-panel-section-grip" data-drag-handle aria-hidden="true"
            title={props.t("instanceShell.rightPanel.customize.dragToReorder")}
            {...sortable.dragActivators}>
            <GripVertical />
          </span>
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
  const permissionSession = createMemo(() =>
    props.isActive() && !props.customization().hiddenStatusSectionIds.includes(CONVERSATION_PERMISSIONS_SECTION_ID)
      ? props.activeSession()?.id : undefined,
  )
  const permissions = createMemo(() => {
    const sessionId = permissionSession()
    if (sessionId) return createConversationPermissionsState(props.instanceId, sessionId)
  })
  const shellLocation = createMemo(() => props.activeSession()?.location ?? { directory: props.instance.folder })
  const shellState = createMemo(() => shellStore.getState(props.instanceId, shellLocation().directory, shellLocation().workspaceID))
  const shellsById = createMemo(() => new Map(shellState().items.map(shell => [shell.id, shell])))
  const [outputShell, setOutputShell] = createSignal<{ shell: ShellInfo; location: LocationRef; instanceId: string } | null>(null)
  const [removingShells, setRemovingShells] = createSignal<ReadonlySet<string>>(new Set())

  createEffect(() => {
    if (!props.isActive() || !isSectionExpanded("background-processes")
      || props.customization().hiddenStatusSectionIds.includes("background-processes")) return
    const { directory, workspaceID } = shellLocation()
    onCleanup(shellStore.watch(props.instanceId, directory, workspaceID))
    void shellStore.load(props.instanceId, directory, workspaceID)
  })

  const removeShell = async (shellId: string, command: string, running: boolean, source: HTMLButtonElement) => {
    const instanceId = props.instanceId
    const location = { ...shellLocation() }
    const key = JSON.stringify([instanceId, location, shellId])
    if (removingShells().has(key)) return
    const row = source.closest(".status-process-card")!
    const next = row.nextElementSibling?.querySelector<HTMLButtonElement>(".window-icon-button")
      ?? row.previousElementSibling?.querySelector<HTMLButtonElement>(".window-icon-button")
    const section = row.closest(".right-panel-section-draggable")?.querySelector<HTMLButtonElement>("[data-status-section-trigger]")
    const returnFocus = () => {
      const target = [source, next, section].find(element => element?.isConnected)
      target?.focus({ preventScroll: true })
    }
    setRemovingShells(current => new Set([...current, key]))
    try {
      const action = running ? "stopRemove" : "remove"
      const confirmed = await showConfirmDialog(
        props.t(`instanceShell.backgroundProcesses.${action}.message`, { title: command }),
        {
          title: props.t(`instanceShell.backgroundProcesses.${action}.title`),
          confirmLabel: props.t(`instanceShell.backgroundProcesses.actions.${action}`),
          returnFocus,
        },
      )
      if (confirmed && !await shellStore.remove(instanceId, location.directory, shellId, location.workspaceID)) {
        showToastNotification({ category: "sessions", message: props.t("instanceShell.backgroundProcesses.error"), variant: "error" })
      }
    } finally {
      setRemovingShells(current => { const next = new Set(current); next.delete(key); return next })
      if (!source.isConnected && document.activeElement === document.body) returnFocus()
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
            <For each={[...shellsById().keys()]}>
              {(id) => {
                const shell = createMemo<ShellInfo>(previous => shellsById().get(id) ?? previous!)
                return (
                  <BackgroundShellRow shell={shell()}
                    removing={shellState().loading || removingShells().has(JSON.stringify([props.instanceId, shellLocation(), id]))}
                    onOutput={() => setOutputShell({ shell: shell(), location: { ...shellLocation() }, instanceId: props.instanceId })}
                    onRemove={source => void removeShell(id, shell().command, shell().status === "running", source)} />
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
          <ContextUsagePanel instanceId={props.instanceId} sessionId={props.activeSession()!.id} summary expanded={isSectionExpanded("tokens")} />
        </Show>
      ),
      renderPermissions: () => (
        <Show when={permissions()} keyed>{state => <ConversationPermissions state={state} />}</Show>
      ),
      renderPermissionsSummary: () => (
        <Show when={permissions()} keyed>{state => <ConversationPermissionsSummary state={state} />}</Show>
      ),
      renderPermissionsInfo: () => <ConversationPermissionsInfo />,
      renderProviderUsage,
      renderBackgroundProcesses,
      renderMcpStatus: () => <InstanceServiceStatus initialInstance={props.instance} sections={["mcp"]} showSectionHeadings={false} class="space-y-2" />,
      renderPluginStatus: () => (
        <InstanceServiceStatus
          initialInstance={props.instance}
          sections={["plugins"]}
          showSectionHeadings={false}
          pluginsActive={props.isActive() && isSectionExpanded("plugins")}
          class="space-y-2"
        />
      ),
    }).statusSections ?? [])
  const allStatusSections = createMemo<RightPanelSectionModule[]>(() => [...coreSections, ...(props.extraSections ?? [])])
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
      <Show when={props.activeSession()?.id}>
        {(sessionId) => (
          <>
            <SessionGoalLine instanceId={props.instanceId} sessionId={sessionId()} active={props.isActive()} />
            <SessionAutomationsBlock instanceId={props.instanceId} sessionId={sessionId()} active={props.isActive()} />
          </>
        )}
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
      <ShellOutputDialog
        open={Boolean(outputShell())}
        instanceId={outputShell()?.instanceId ?? props.instanceId}
        directory={outputShell()?.location.directory ?? shellLocation().directory}
        workspaceID={outputShell()?.location.workspaceID}
        shell={outputShell()?.shell ?? null}
        onClose={() => setOutputShell(null)}
      />
    </div>
  )
}

export default StatusTab
