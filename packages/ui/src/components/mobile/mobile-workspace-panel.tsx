import { Component, For, Show, createMemo, createSignal } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import { Accordion } from "@kobalte/core"
import {
  ChevronDown,
  FileText,
  Clock,
  FolderGit,
  GitBranch,
  Eye,
  Edit3,
  PenLine,
  Plus,
  Trash2,
  CheckCircle,
  XCircle,
  Loader2,
  ListChecks,
  SquareKanban,
  RefreshCw,
} from "lucide-solid"
import { TodoListView } from "../tool-call/renderers/todo"
import {
  getFilesTouched,
  getRecentActions,
  getGitStatus,
  type FileOperationType,
  type RecentAction,
} from "../../stores/workspace-state"
import { messageStoreBus } from "../../stores/message-v2/bus"
import { activeSessionId } from "../../stores/sessions"
import { getLinearTasks, fetchLinearTasks, linearStatus } from "../../stores/linear-tasks"
import LinearTaskList from "../linear-task-list"
import { cn } from "../../lib/cn"

interface MobileWorkspacePanelProps {
  instanceId: string
  instanceFolder?: string
}

const MobileWorkspacePanel: Component<MobileWorkspacePanelProps> = (props) => {
  const [expandedItems, setExpandedItems] = createSignal<string[]>(["linear", "tasks", "git"])

  const activeSessionIdForInstance = createMemo(() => activeSessionId().get(props.instanceId) || null)
  const messageStore = createMemo(() => messageStoreBus.getOrCreate(props.instanceId))

  const latestTodoState = createMemo<ToolState | null>(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return null
    const store = messageStore()
    if (!store) return null
    const snapshot = store.state.latestTodos[sessionId]
    if (!snapshot) return null
    const message = store.getMessage(snapshot.messageId)
    if (!message) return null
    const partRecord = message.parts?.[snapshot.partId]
    const part = partRecord?.data as { type?: string; tool?: string; state?: ToolState }
    if (!part || part.type !== "tool" || part.tool !== "todowrite") return null
    const state = part.state
    if (!state || state.status !== "completed") return null
    return state
  })

  const filesTouched = createMemo(() => getFilesTouched(props.instanceId))
  const recentActions = createMemo(() => getRecentActions(props.instanceId))
  const gitStatus = createMemo(() => getGitStatus(props.instanceId))

  const getOperationIcon = (op: FileOperationType) => {
    switch (op) {
      case "read": return <Eye class="w-3 h-3" />
      case "edit": return <Edit3 class="w-3 h-3" />
      case "write": return <PenLine class="w-3 h-3" />
      case "create": return <Plus class="w-3 h-3" />
      case "delete": return <Trash2 class="w-3 h-3" />
      default: return <FileText class="w-3 h-3" />
    }
  }

  const getOperationClass = (op: FileOperationType) => {
    switch (op) {
      case "read": return "text-info"
      case "edit": return "text-warning"
      case "write": return "text-success"
      case "create": return "text-success"
      case "delete": return "text-destructive"
      default: return "text-muted-foreground"
    }
  }

  const getStatusIcon = (status: RecentAction["status"]) => {
    switch (status) {
      case "running": return <Loader2 class="w-3 h-3 animate-spin" />
      case "complete": return <CheckCircle class="w-3 h-3" />
      case "error": return <XCircle class="w-3 h-3" />
    }
  }

  const getStatusClass = (status: RecentAction["status"]) => {
    switch (status) {
      case "running": return "text-info"
      case "complete": return "text-success"
      case "error": return "text-destructive"
    }
  }

  const formatRelativeTime = (timestamp: number) => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000)
    if (seconds < 60) return "just now"
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }

  const getFileName = (path: string) => {
    const parts = path.replace(/\\/g, "/").split("/")
    return parts[parts.length - 1] || path
  }

  const getRelativePath = (fullPath: string) => {
    const folder = props.instanceFolder?.replace(/\\/g, "/") || ""
    const path = fullPath.replace(/\\/g, "/")
    if (folder && path.startsWith(folder)) {
      return path.slice(folder.length).replace(/^\//, "")
    }
    return path
  }

  const linearIssues = createMemo(() => getLinearTasks(props.instanceId))

  const sections = [
    {
      id: "linear",
      label: "Linear Tasks",
      icon: () => <SquareKanban class="w-4 h-4" />,
      count: () => {
        const issues = linearIssues()
        if (issues.length === 0) return null
        const active = issues.filter(i => {
          const s = i.status.toLowerCase()
          return s !== "done" && s !== "completed" && s !== "canceled" && s !== "cancelled"
        }).length
        return active > 0 ? `${active} active` : null
      },
      headerAction: () => (
        <button
          type="button"
          class="inline-flex items-center justify-center w-8 h-8 -m-1 rounded text-muted-foreground hover:text-foreground transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            void fetchLinearTasks(props.instanceId)
          }}
          aria-label="Sync Linear tasks"
        >
          <RefreshCw class={cn("w-3.5 h-3.5", linearStatus() === "connecting" && "animate-spin")} />
        </button>
      ),
      render: () => (
        <LinearTaskList issues={linearIssues()} emptyMessage="Connect Linear in settings to see tasks" />
      ),
    },
    {
      id: "tasks",
      label: "Tasks",
      icon: () => <ListChecks class="w-4 h-4" />,
      count: () => {
        const todoState = latestTodoState()
        if (!todoState?.todos?.length) return null
        const pending = todoState.todos.filter((t: any) => t.status !== "completed").length
        return pending > 0 ? `${pending} pending` : null
      },
      render: () => {
        const sessionId = activeSessionIdForInstance()
        if (!sessionId || sessionId === "info") {
          return <p class="text-xs text-muted-foreground">Select a session to view plan.</p>
        }
        const todoState = latestTodoState()
        if (!todoState) {
          return <p class="text-xs text-muted-foreground">Nothing planned yet.</p>
        }
        return <TodoListView state={todoState} emptyLabel="Nothing planned yet." showStatusLabel={false} />
      },
    },
    {
      id: "git",
      label: "Git Status",
      icon: () => <FolderGit class="w-4 h-4" />,
      count: () => {
        const status = gitStatus()
        if (!status) return null
        return `${status.branch}${status.ahead > 0 ? ` \u2191${status.ahead}` : ""}${status.behind > 0 ? ` \u2193${status.behind}` : ""}`
      },
      render: () => (
        <Show
          when={gitStatus()}
          fallback={<p class="text-xs text-muted-foreground italic py-2">Git status not available</p>}
        >
          {(status) => (
            <div class="space-y-3">
              <div class="flex items-center gap-2 text-sm">
                <GitBranch class="w-4 h-4 text-info" />
                <span class="font-medium text-foreground">{status().branch}</span>
                <Show when={status().ahead > 0 || status().behind > 0}>
                  <span class="flex items-center gap-1 text-xs">
                    <Show when={status().ahead > 0}>
                      <span class="text-success">+{status().ahead}</span>
                    </Show>
                    <Show when={status().behind > 0}>
                      <span class="text-destructive">-{status().behind}</span>
                    </Show>
                  </span>
                </Show>
              </div>
              <Show when={status().staged.length > 0}>
                <div class="space-y-1">
                  <span class="text-xs font-medium text-success">Staged ({status().staged.length})</span>
                  <ul class="space-y-0.5">
                    <For each={status().staged.slice(0, 8)}>
                      {(file) => <li class="text-xs text-muted-foreground truncate pl-2" title={file}>{getFileName(file)}</li>}
                    </For>
                    <Show when={status().staged.length > 8}>
                      <li class="text-xs text-muted-foreground italic pl-2">+{status().staged.length - 8} more</li>
                    </Show>
                  </ul>
                </div>
              </Show>
              <Show when={status().modified.length > 0}>
                <div class="space-y-1">
                  <span class="text-xs font-medium text-warning">Modified ({status().modified.length})</span>
                  <ul class="space-y-0.5">
                    <For each={status().modified.slice(0, 8)}>
                      {(file) => <li class="text-xs text-muted-foreground truncate pl-2" title={file}>{getFileName(file)}</li>}
                    </For>
                    <Show when={status().modified.length > 8}>
                      <li class="text-xs text-muted-foreground italic pl-2">+{status().modified.length - 8} more</li>
                    </Show>
                  </ul>
                </div>
              </Show>
              <Show when={status().untracked.length > 0}>
                <div class="space-y-1">
                  <span class="text-xs font-medium text-muted-foreground">Untracked ({status().untracked.length})</span>
                  <ul class="space-y-0.5">
                    <For each={status().untracked.slice(0, 8)}>
                      {(file) => <li class="text-xs text-muted-foreground truncate pl-2" title={file}>{getFileName(file)}</li>}
                    </For>
                    <Show when={status().untracked.length > 8}>
                      <li class="text-xs text-muted-foreground italic pl-2">+{status().untracked.length - 8} more</li>
                    </Show>
                  </ul>
                </div>
              </Show>
              <Show when={status().staged.length === 0 && status().modified.length === 0 && status().untracked.length === 0}>
                <p class="text-xs text-success italic">Working tree clean</p>
              </Show>
            </div>
          )}
        </Show>
      ),
    },
    {
      id: "actions",
      label: "Recent Actions",
      icon: () => <Clock class="w-4 h-4" />,
      count: () => recentActions().length || null,
      render: () => (
        <Show
          when={recentActions().length > 0}
          fallback={<p class="text-xs text-muted-foreground italic py-2">No recent actions</p>}
        >
          <ul class="space-y-0.5">
            <For each={recentActions().slice(0, 20)}>
              {(action) => (
                <li class={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${getStatusClass(action.status)}`}>
                  <span class="flex-shrink-0">{getStatusIcon(action.status)}</span>
                  <span class="truncate text-foreground" title={action.summary}>{action.summary}</span>
                  <span class="ml-auto text-muted-foreground flex-shrink-0">{formatRelativeTime(action.timestamp)}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      ),
    },
    {
      id: "files",
      label: "Files Touched",
      icon: () => <FileText class="w-4 h-4" />,
      count: () => filesTouched().length || null,
      render: () => (
        <Show
          when={filesTouched().length > 0}
          fallback={<p class="text-xs text-muted-foreground italic py-2">No files touched yet</p>}
        >
          <ul class="space-y-0.5">
            <For each={filesTouched().slice(0, 30)}>
              {(file) => (
                <li>
                  <div class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs">
                    <span class={`flex-shrink-0 ${getOperationClass(file.operation)}`}>
                      {getOperationIcon(file.operation)}
                    </span>
                    <span class="font-medium text-foreground truncate">{getFileName(file.path)}</span>
                    <span class="text-muted-foreground truncate ml-auto" title={file.path}>{getRelativePath(file.path)}</span>
                  </div>
                </li>
              )}
            </For>
            <Show when={filesTouched().length > 30}>
              <p class="text-xs text-muted-foreground mt-2 text-center">+{filesTouched().length - 30} more files</p>
            </Show>
          </ul>
        </Show>
      ),
    },
  ]

  return (
    <div class="flex flex-col h-full" data-testid="mobile-workspace-panel">
      <div class="flex items-center px-4 py-3 border-b border-border">
        <h2 class="text-lg font-semibold text-foreground">Workspace</h2>
      </div>
      <div class="flex-1 overflow-y-auto">
        <Accordion.Root
          class="flex flex-col"
          collapsible
          multiple
          value={expandedItems()}
          onChange={setExpandedItems}
        >
          <For each={sections}>
            {(section) => (
              <Accordion.Item value={section.id} class="border-b border-border">
                <Accordion.Header>
                  <Accordion.Trigger class="flex items-center justify-between w-full px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer">
                    <span class="flex items-center gap-2">
                      {section.icon()}
                      {section.label}
                    </span>
                    <span class="flex items-center gap-2">
                      <Show when={section.count() !== null}>
                        <span class="text-xs font-normal text-muted-foreground">{section.count()}</span>
                      </Show>
                      <Show when={section.headerAction}>
                        {section.headerAction!()}
                      </Show>
                      <ChevronDown
                        class={`h-4 w-4 transition-transform duration-150 ${expandedItems().includes(section.id) ? "rotate-180" : ""}`}
                      />
                    </span>
                  </Accordion.Trigger>
                </Accordion.Header>
                <Accordion.Content class="px-4 py-2 text-sm text-primary">
                  {section.render()}
                </Accordion.Content>
              </Accordion.Item>
            )}
          </For>
        </Accordion.Root>
      </div>
    </div>
  )
}

export default MobileWorkspacePanel
