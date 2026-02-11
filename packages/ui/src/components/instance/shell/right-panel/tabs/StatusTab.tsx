import { For, Show, type Accessor, type Component } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import { Accordion } from "@kobalte/core"

import { ChevronDown, TerminalSquare, Trash2, XOctagon } from "lucide-solid"

import type { Instance } from "../../../../../types/instance"
import type { BackgroundProcess } from "../../../../../../../server/src/api-types"
import type { Session } from "../../../../../types/session"

import ContextUsagePanel from "../../../../session/context-usage-panel"
import { TodoListView } from "../../../../tool-call/renderers/todo"
import InstanceServiceStatus from "../../../../instance-service-status"

interface StatusTabProps {
  t: (key: string, vars?: Record<string, any>) => string

  instanceId: string
  instance: Instance

  activeSessionId: Accessor<string | null>
  activeSession: Accessor<Session | null>
  activeSessionDiffs: Accessor<any[] | undefined>

  latestTodoState: Accessor<ToolState | null>

  backgroundProcessList: Accessor<BackgroundProcess[]>
  onOpenBackgroundOutput: (process: BackgroundProcess) => void
  onStopBackgroundProcess: (processId: string) => Promise<void> | void
  onTerminateBackgroundProcess: (processId: string) => Promise<void> | void

  expandedItems: Accessor<string[]>
  onExpandedItemsChange: (values: string[]) => void

  onOpenChangesTab: (file?: string) => void
}

const StatusTab: Component<StatusTabProps> = (props) => {
  const isSectionExpanded = (id: string) => props.expandedItems().includes(id)

  const renderStatusSessionChanges = () => {
    const sessionId = props.activeSessionId()
    if (!sessionId || sessionId === "info") {
      return (
        <div class="right-panel-empty right-panel-empty--left">
          <span class="text-xs">{props.t("instanceShell.sessionChanges.noSessionSelected")}</span>
        </div>
      )
    }

    const diffs = props.activeSessionDiffs()
    if (diffs === undefined) {
      return (
        <div class="right-panel-empty right-panel-empty--left">
          <span class="text-xs">{props.t("instanceShell.sessionChanges.loading")}</span>
        </div>
      )
    }

    if (!Array.isArray(diffs) || diffs.length === 0) {
      return (
        <div class="right-panel-empty right-panel-empty--left">
          <span class="text-xs">{props.t("instanceShell.sessionChanges.empty")}</span>
        </div>
      )
    }

    const sorted = [...diffs].sort((a, b) => String(a.file || "").localeCompare(String(b.file || "")))
    const totals = sorted.reduce(
      (acc, item) => {
        acc.additions += typeof item.additions === "number" ? item.additions : 0
        acc.deletions += typeof item.deletions === "number" ? item.deletions : 0
        return acc
      },
      { additions: 0, deletions: 0 },
    )

    return (
      <div class="flex flex-col gap-3 min-h-0">
        <div class="flex items-center justify-between gap-2 text-[11px] text-secondary">
          <span>{props.t("instanceShell.sessionChanges.filesChanged", { count: sorted.length })}</span>
          <span class="flex items-center gap-2">
            <span style={{ color: "var(--session-status-idle-fg)" }}>{`+${totals.additions}`}</span>
            <span style={{ color: "var(--session-status-working-fg)" }}>{`-${totals.deletions}`}</span>
          </span>
        </div>

        <div class="rounded-md border border-base bg-surface-secondary p-2 max-h-[40vh] overflow-y-auto">
          <div class="flex flex-col">
            <For each={sorted}>
              {(item) => (
                <button
                  type="button"
                  class="border-b border-base last:border-b-0 text-left hover:bg-surface-muted rounded-sm"
                  onClick={() => props.onOpenChangesTab(item.file)}
                  title={props.t("instanceShell.sessionChanges.actions.show")}
                >
                  <div class="flex items-center justify-between gap-3">
                    <div
                      class="text-xs font-mono text-primary min-w-0 flex-1 overflow-hidden whitespace-nowrap"
                      title={item.file}
                      style="text-overflow: ellipsis; direction: rtl; text-align: left; unicode-bidi: plaintext;"
                    >
                      {item.file}
                    </div>
                    <div class="flex items-center gap-2 text-[11px] flex-shrink-0">
                      <span style={{ color: "var(--session-status-idle-fg)" }}>{`+${item.additions}`}</span>
                      <span style={{ color: "var(--session-status-working-fg)" }}>{`-${item.deletions}`}</span>
                    </div>
                  </div>
                </button>
              )}
            </For>
          </div>
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

  const statusSections = [
    {
      id: "session-changes",
      labelKey: "instanceShell.rightPanel.sections.sessionChanges",
      render: renderStatusSessionChanges,
    },
    {
      id: "plan",
      labelKey: "instanceShell.rightPanel.sections.plan",
      render: renderPlanSectionContent,
    },
    {
      id: "background-processes",
      labelKey: "instanceShell.rightPanel.sections.backgroundProcesses",
      render: renderBackgroundProcesses,
    },
    {
      id: "mcp",
      labelKey: "instanceShell.rightPanel.sections.mcp",
      render: () => (
        <InstanceServiceStatus
          initialInstance={props.instance}
          sections={["mcp"]}
          showSectionHeadings={false}
          class="space-y-2"
        />
      ),
    },
    {
      id: "lsp",
      labelKey: "instanceShell.rightPanel.sections.lsp",
      render: () => (
        <InstanceServiceStatus
          initialInstance={props.instance}
          sections={["lsp"]}
          showSectionHeadings={false}
          class="space-y-2"
        />
      ),
    },
    {
      id: "plugins",
      labelKey: "instanceShell.rightPanel.sections.plugins",
      render: () => (
        <InstanceServiceStatus
          initialInstance={props.instance}
          sections={["plugins"]}
          showSectionHeadings={false}
          class="space-y-2"
        />
      ),
    },
  ]

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
        <For each={statusSections}>
          {(section) => (
            <Accordion.Item value={section.id} class="right-panel-accordion-item">
              <Accordion.Header>
                <Accordion.Trigger class="right-panel-accordion-trigger">
                  <span>{props.t(section.labelKey)}</span>
                  <ChevronDown
                    class={`right-panel-accordion-chevron ${isSectionExpanded(section.id) ? "right-panel-accordion-chevron-expanded" : ""}`}
                  />
                </Accordion.Trigger>
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
