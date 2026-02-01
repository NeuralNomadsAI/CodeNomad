import { Component, Show, For, createSignal, createMemo, createEffect } from "solid-js"
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Edit3,
  PenLine,
  Trash2,
  Plus,
  Eye,
  GitBranch,
  GitCommit,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  FolderGit,
} from "lucide-solid"
import {
  getFilesTouched,
  getRecentActions,
  getGitStatus,
  type FileOperation,
  type RecentAction,
  type GitStatus,
  type FileOperationType,
} from "../stores/workspace-state"
import { cn } from "../lib/cn"

interface WorkspacePanelProps {
  instanceId: string
  instanceFolder?: string
  onFileClick?: (path: string) => void
}

const WorkspacePanel: Component<WorkspacePanelProps> = (props) => {
  const [filesTouchedExpanded, setFilesTouchedExpanded] = createSignal(true)
  const [recentActionsExpanded, setRecentActionsExpanded] = createSignal(true)
  const [gitStatusExpanded, setGitStatusExpanded] = createSignal(true)

  const filesTouched = createMemo(() => getFilesTouched(props.instanceId))
  const recentActions = createMemo(() => getRecentActions(props.instanceId))
  const gitStatus = createMemo(() => getGitStatus(props.instanceId))

  const getOperationIcon = (op: FileOperationType) => {
    switch (op) {
      case "read":
        return <Eye class="w-3 h-3" />
      case "edit":
        return <Edit3 class="w-3 h-3" />
      case "write":
        return <PenLine class="w-3 h-3" />
      case "create":
        return <Plus class="w-3 h-3" />
      case "delete":
        return <Trash2 class="w-3 h-3" />
      default:
        return <FileText class="w-3 h-3" />
    }
  }

  const getOperationClass = (op: FileOperationType) => {
    switch (op) {
      case "read":
        return "text-info"
      case "edit":
        return "text-warning"
      case "write":
        return "text-success"
      case "create":
        return "text-success"
      case "delete":
        return "text-destructive"
      default:
        return "text-muted-foreground"
    }
  }

  const getStatusIcon = (status: RecentAction["status"]) => {
    switch (status) {
      case "running":
        return <Loader2 class="w-3 h-3 animate-spin" />
      case "complete":
        return <CheckCircle class="w-3 h-3" />
      case "error":
        return <XCircle class="w-3 h-3" />
    }
  }

  const getStatusClass = (status: RecentAction["status"]) => {
    switch (status) {
      case "running":
        return "text-info"
      case "complete":
        return "text-success"
      case "error":
        return "text-destructive"
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

  const getRelativePath = (fullPath: string) => {
    if (!props.instanceFolder) return fullPath
    const folder = props.instanceFolder.replace(/\\/g, "/")
    const path = fullPath.replace(/\\/g, "/")
    if (path.startsWith(folder)) {
      return path.slice(folder.length).replace(/^\//, "")
    }
    return path
  }

  const getFileName = (path: string) => {
    const parts = path.replace(/\\/g, "/").split("/")
    return parts[parts.length - 1] || path
  }

  return (
    <div class="flex flex-col">
      {/* Files Touched Section */}
      <section class="border-b border-border">
        <button
          type="button"
          class="w-full flex items-center justify-between gap-3 px-4 py-3 text-sm font-semibold uppercase tracking-wide transition-colors text-muted-foreground hover:bg-accent hover:text-foreground outline-none"
          onClick={() => setFilesTouchedExpanded((prev) => !prev)}
          aria-expanded={filesTouchedExpanded()}
        >
          <span class="flex items-center gap-2">
            {filesTouchedExpanded() ? (
              <ChevronDown class="w-4 h-4" />
            ) : (
              <ChevronRight class="w-4 h-4" />
            )}
            <FileText class="w-4 h-4" />
            Files Touched
          </span>
          <span class="text-xs font-medium px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground">{filesTouched().length}</span>
        </button>

        <Show when={filesTouchedExpanded()}>
          <div class="px-4 pb-3">
            <Show
              when={filesTouched().length > 0}
              fallback={
                <p class="text-xs text-muted-foreground italic py-2">No files touched yet</p>
              }
            >
              <ul class="space-y-0.5">
                <For each={filesTouched().slice(0, 20)}>
                  {(file) => (
                    <li>
                      <button
                        type="button"
                        class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors hover:bg-accent text-left"
                        onClick={() => props.onFileClick?.(file.path)}
                        title={file.path}
                      >
                        <span class={cn("flex-shrink-0", getOperationClass(file.operation))}>
                          {getOperationIcon(file.operation)}
                        </span>
                        <span class="font-medium text-foreground truncate">
                          {getFileName(file.path)}
                        </span>
                        <span class="text-muted-foreground truncate ml-auto" title={file.path}>
                          {getRelativePath(file.path)}
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={filesTouched().length > 20}>
                <p class="text-xs text-muted-foreground mt-2 text-center">
                  +{filesTouched().length - 20} more files
                </p>
              </Show>
            </Show>
          </div>
        </Show>
      </section>

      {/* Recent Actions Section */}
      <section class="border-b border-border">
        <button
          type="button"
          class="w-full flex items-center justify-between gap-3 px-4 py-3 text-sm font-semibold uppercase tracking-wide transition-colors text-muted-foreground hover:bg-accent hover:text-foreground outline-none"
          onClick={() => setRecentActionsExpanded((prev) => !prev)}
          aria-expanded={recentActionsExpanded()}
        >
          <span class="flex items-center gap-2">
            {recentActionsExpanded() ? (
              <ChevronDown class="w-4 h-4" />
            ) : (
              <ChevronRight class="w-4 h-4" />
            )}
            <Clock class="w-4 h-4" />
            Recent Actions
          </span>
          <span class="text-xs font-medium px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground">{recentActions().length}</span>
        </button>

        <Show when={recentActionsExpanded()}>
          <div class="px-4 pb-3">
            <Show
              when={recentActions().length > 0}
              fallback={
                <p class="text-xs text-muted-foreground italic py-2">No recent actions</p>
              }
            >
              <ul class="space-y-0.5">
                <For each={recentActions().slice(0, 15)}>
                  {(action) => (
                    <li class={cn("flex items-center gap-2 px-2 py-1.5 rounded text-xs", getStatusClass(action.status))}>
                      <span class="flex-shrink-0">
                        {getStatusIcon(action.status)}
                      </span>
                      <span class="truncate text-foreground" title={action.summary}>
                        {action.summary}
                      </span>
                      <span class="ml-auto text-muted-foreground flex-shrink-0">
                        {formatRelativeTime(action.timestamp)}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </Show>
      </section>

      {/* Git Status Section */}
      <section class="border-b border-border">
        <button
          type="button"
          class="w-full flex items-center justify-between gap-3 px-4 py-3 text-sm font-semibold uppercase tracking-wide transition-colors text-muted-foreground hover:bg-accent hover:text-foreground outline-none"
          onClick={() => setGitStatusExpanded((prev) => !prev)}
          aria-expanded={gitStatusExpanded()}
        >
          <span class="flex items-center gap-2">
            {gitStatusExpanded() ? (
              <ChevronDown class="w-4 h-4" />
            ) : (
              <ChevronRight class="w-4 h-4" />
            )}
            <FolderGit class="w-4 h-4" />
            Git Status
          </span>
        </button>

        <Show when={gitStatusExpanded()}>
          <div class="px-4 pb-3">
            <Show
              when={gitStatus()}
              fallback={
                <p class="text-xs text-muted-foreground italic py-2">Git status not available</p>
              }
            >
              {(status) => (
                <div class="space-y-3">
                  {/* Branch info */}
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

                  {/* Staged changes */}
                  <Show when={status().staged.length > 0}>
                    <div class="space-y-1">
                      <span class="text-xs font-medium text-success">
                        Staged ({status().staged.length})
                      </span>
                      <ul class="space-y-0.5">
                        <For each={status().staged.slice(0, 5)}>
                          {(file) => (
                            <li class="text-xs text-muted-foreground truncate pl-2" title={file}>
                              {getFileName(file)}
                            </li>
                          )}
                        </For>
                        <Show when={status().staged.length > 5}>
                          <li class="text-xs text-muted-foreground italic pl-2">
                            +{status().staged.length - 5} more
                          </li>
                        </Show>
                      </ul>
                    </div>
                  </Show>

                  {/* Modified changes */}
                  <Show when={status().modified.length > 0}>
                    <div class="space-y-1">
                      <span class="text-xs font-medium text-warning">
                        Modified ({status().modified.length})
                      </span>
                      <ul class="space-y-0.5">
                        <For each={status().modified.slice(0, 5)}>
                          {(file) => (
                            <li class="text-xs text-muted-foreground truncate pl-2" title={file}>
                              {getFileName(file)}
                            </li>
                          )}
                        </For>
                        <Show when={status().modified.length > 5}>
                          <li class="text-xs text-muted-foreground italic pl-2">
                            +{status().modified.length - 5} more
                          </li>
                        </Show>
                      </ul>
                    </div>
                  </Show>

                  {/* Untracked files */}
                  <Show when={status().untracked.length > 0}>
                    <div class="space-y-1">
                      <span class="text-xs font-medium text-muted-foreground">
                        Untracked ({status().untracked.length})
                      </span>
                      <ul class="space-y-0.5">
                        <For each={status().untracked.slice(0, 5)}>
                          {(file) => (
                            <li class="text-xs text-muted-foreground truncate pl-2" title={file}>
                              {getFileName(file)}
                            </li>
                          )}
                        </For>
                        <Show when={status().untracked.length > 5}>
                          <li class="text-xs text-muted-foreground italic pl-2">
                            +{status().untracked.length - 5} more
                          </li>
                        </Show>
                      </ul>
                    </div>
                  </Show>

                  {/* No changes */}
                  <Show when={status().staged.length === 0 && status().modified.length === 0 && status().untracked.length === 0}>
                    <p class="text-xs text-success italic">Working tree clean</p>
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </section>
    </div>
  )
}

export default WorkspacePanel
