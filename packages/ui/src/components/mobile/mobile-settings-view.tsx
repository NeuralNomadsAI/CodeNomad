import { Component, Show, createMemo } from "solid-js"
import { ChevronRight, Plug, Server, Shield, FileText, Settings as SettingsIcon, GitBranch, SquareKanban } from "lucide-solid"
import type { Session } from "../../types/session"
import type { Instance } from "../../types/instance"
import AgentSelector from "../agent-selector"
import ModelSelector from "../model-selector"
import ThinkingSelector from "../thinking-selector"
import PermissionToggle from "../permission-toggle"
import { Separator } from "../ui/separator"
import { formatTokenTotal, formatCost } from "../../lib/formatters"
import { getGitStatus } from "../../stores/workspace-state"
import { getActiveMcpServerCount } from "../../stores/project-mcp"
import { sessionInfoByInstance } from "../../stores/session-state"
import { sseManager } from "../../lib/sse-manager"
import { linearStatus } from "../../stores/linear-tasks"

interface MobileSettingsViewProps {
  instance: Instance
  activeSession: Session | null
  onAgentChange: (sessionId: string, agent: string) => Promise<void>
  onModelChange: (sessionId: string, model: { providerId: string; modelId: string }) => Promise<void>
  onOpenMcpSettings: () => void
  onOpenLspSettings: () => void
  onOpenGovernance: () => void
  onOpenDirectives: () => void
  onOpenFullSettings: () => void
  onOpenProjectSwitcher: () => void
  onOpenInstanceInfo: () => void
}

const rowClass =
  "flex items-center justify-between w-full px-4 py-3 min-h-[48px] text-sm text-foreground hover:bg-accent/30 active:bg-accent/50 transition-colors text-left"

const MobileSettingsView: Component<MobileSettingsViewProps> = (props) => {
  const gitStatus = createMemo(() => getGitStatus(props.instance.id))

  const mcpCount = createMemo(() => getActiveMcpServerCount(props.instance.id, props.instance.folder))

  const lspStatus = createMemo(() => {
    const status = props.instance.metadata?.lspStatus
    if (!status) return { connected: 0, total: 0 }
    return {
      connected: status.filter((s) => s.status === "connected").length,
      total: status.length,
    }
  })

  const connectionStatus = createMemo(() => sseManager.getStatus(props.instance.id))

  const totalTokens = createMemo(() => {
    const sessionInfoMap = sessionInfoByInstance().get(props.instance.id)
    if (!sessionInfoMap) return { input: 0, output: 0, cost: 0 }
    let input = 0
    let output = 0
    let cost = 0
    for (const info of sessionInfoMap.values()) {
      input += info.inputTokens ?? 0
      output += info.outputTokens ?? 0
      cost += info.cost ?? 0
    }
    return { input, output, cost }
  })

  const projectName = createMemo(() => {
    const folder = props.instance.folder.replace(/\/+$/, "")
    return folder.split("/").pop() || props.instance.folder
  })

  return (
    <div class="flex flex-col h-full" data-testid="mobile-settings-view">
      <div class="flex items-center px-4 py-3 border-b border-border">
        <h2 class="text-lg font-semibold text-foreground">Settings</h2>
      </div>

      <div class="flex-1 overflow-y-auto">
        {/* Session Configuration */}
        <Show when={props.activeSession}>
          {(session) => (
            <div class="px-4 py-4">
              <h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Session Configuration
              </h3>
              <div class="flex flex-col gap-4 [&>*]:w-full">
                <AgentSelector
                  instanceId={props.instance.id}
                  sessionId={session().id}
                  currentAgent={session().agent}
                  onAgentChange={(agent) => props.onAgentChange(session().id, agent)}
                />
                <ModelSelector
                  instanceId={props.instance.id}
                  sessionId={session().id}
                  currentModel={session().model}
                  onModelChange={(model) => props.onModelChange(session().id, model)}
                />
                <ThinkingSelector
                  currentModelId={`${session().model.providerId}/${session().model.modelId}`}
                  instanceId={props.instance.id}
                />
                <PermissionToggle
                  instanceId={props.instance.id}
                  sessionId={session().id}
                />
              </div>
            </div>
          )}
        </Show>

        <Separator />

        {/* Project & Instance */}
        <div>
          <button type="button" class={rowClass} onClick={props.onOpenProjectSwitcher}>
            <span>Project: <span class="font-medium">{projectName()}</span></span>
            <ChevronRight class="w-4 h-4 text-muted-foreground" />
          </button>
          <button type="button" class={rowClass} onClick={props.onOpenInstanceInfo}>
            <span>
              Instance: :{props.instance.port ?? "—"}{" "}
              <span class={connectionStatus() === "connected" ? "text-success" : "text-warning"}>
                {connectionStatus() === "connected" ? "Connected" : connectionStatus() ?? "Unknown"}
              </span>
            </span>
            <ChevronRight class="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <Separator />

        {/* Advanced */}
        <div>
          <h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-4 pt-4 pb-2">
            Advanced
          </h3>
          <button type="button" class={rowClass} onClick={props.onOpenMcpSettings}>
            <span class="flex items-center gap-2">
              <Plug class="w-4 h-4 text-muted-foreground" />
              MCP Servers ({mcpCount()} active)
            </span>
            <ChevronRight class="w-4 h-4 text-muted-foreground" />
          </button>
          <button type="button" class={rowClass} onClick={props.onOpenLspSettings}>
            <span class="flex items-center gap-2">
              <Server class="w-4 h-4 text-muted-foreground" />
              LSP Servers ({lspStatus().connected}/{lspStatus().total} connected)
            </span>
            <ChevronRight class="w-4 h-4 text-muted-foreground" />
          </button>
          <div class="flex items-center justify-between w-full px-4 py-3 min-h-[48px] text-sm text-foreground">
            <span class="flex items-center gap-2">
              <SquareKanban class="w-4 h-4 text-muted-foreground" />
              Linear
            </span>
            <span class={linearStatus() === "connected" ? "text-success text-xs font-medium" : "text-muted-foreground text-xs"}>
              {linearStatus() === "connected" ? "Connected" : "Not connected"}
            </span>
          </div>
          <button type="button" class={rowClass} onClick={props.onOpenGovernance}>
            <span class="flex items-center gap-2">
              <Shield class="w-4 h-4 text-muted-foreground" />
              Governance
            </span>
            <ChevronRight class="w-4 h-4 text-muted-foreground" />
          </button>
          <button type="button" class={rowClass} onClick={props.onOpenDirectives}>
            <span class="flex items-center gap-2">
              <FileText class="w-4 h-4 text-muted-foreground" />
              Directives
            </span>
            <ChevronRight class="w-4 h-4 text-muted-foreground" />
          </button>
          <button type="button" class={rowClass} onClick={props.onOpenFullSettings}>
            <span class="flex items-center gap-2">
              <SettingsIcon class="w-4 h-4 text-muted-foreground" />
              Full Settings
            </span>
            <ChevronRight class="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <Separator />

        {/* Status */}
        <div class="px-4 py-4">
          <h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Status
          </h3>
          <div class="space-y-2 text-sm">
            <div class="flex justify-between">
              <span class="text-muted-foreground">Tokens</span>
              <span class="text-foreground tabular-nums">
                {"\u2191"}{formatTokenTotal(totalTokens().input)} in{"  "}
                {"\u2193"}{formatTokenTotal(totalTokens().output)} out
              </span>
            </div>
            <div class="flex justify-between">
              <span class="text-muted-foreground">Cost</span>
              <span class="text-foreground tabular-nums">{formatCost(totalTokens().cost)}</span>
            </div>
            <Show when={gitStatus()}>
              {(status) => (
                <div class="flex justify-between">
                  <span class="text-muted-foreground">Git</span>
                  <span class="flex items-center gap-1.5 text-foreground">
                    <GitBranch class="w-3.5 h-3.5" />
                    {status().branch}
                    <Show when={status().ahead > 0}>
                      <span class="text-success">{"\u2191"}{status().ahead}</span>
                    </Show>
                    <Show when={status().behind > 0}>
                      <span class="text-destructive">{"\u2193"}{status().behind}</span>
                    </Show>
                  </span>
                </div>
              )}
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

export default MobileSettingsView
