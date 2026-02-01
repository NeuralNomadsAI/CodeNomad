import { Component, Show, createMemo } from "solid-js"
import { Folder, Loader2, Shield, FileText, Plug, Server, Settings, Code2, GitBranch } from "lucide-solid"
import { formatTokenTotal, formatCost } from "../lib/formatters"
import { isEraInstalled } from "../stores/era-status"
import { governanceSummary, activeOverridesCount } from "../stores/era-governance"
import { hasProjectDirectives } from "../stores/era-directives"
import { preferences } from "../stores/preferences"
import { cn } from "../lib/cn"

interface BottomStatusBarProps {
  projectName: string
  usedTokens: number
  inputTokens: number
  outputTokens: number
  availableTokens: number | null
  contextWindow: number
  isCompacting: boolean
  providerId: string
  modelId: string
  cost: number
  onModelClick: () => void
  onContextClick: () => void
  onGovernanceClick?: () => void
  onDirectivesClick?: () => void
  onMcpClick?: () => void
  onLspClick?: () => void
  onInstanceClick?: () => void
  onSettingsClick?: () => void
  instancePort?: number
  mcpActiveCount?: number
  lspConnected?: number
  lspTotal?: number
  gitBranch?: string
  gitAhead?: number
  gitBehind?: number
  // Connection status from SSE
  connectionStatus?: "connected" | "connecting" | "disconnected" | "error" | null
  // Working/busy state
  isSessionBusy?: boolean
  elapsedSeconds?: number
  streamingTokens?: number
  onInterrupt?: () => void
}

// Base classes for status bar items
const itemBase = "flex items-center gap-1.5 px-2 py-0.5 rounded-sm transition-colors bg-transparent border-none cursor-default text-inherit text-[length:inherit]"
const itemButton = cn(itemBase, "cursor-pointer hover:bg-accent hover:text-foreground")
const iconBase = "w-3.5 h-3.5 flex-shrink-0 text-muted-foreground"
const textBase = "truncate max-w-[200px]"
const dividerClass = "w-px h-3.5 mx-1.5 bg-border"

const BottomStatusBar: Component<BottomStatusBarProps> = (props) => {
  // Note: availableTokens/contextWindow props are kept for potential future use
  // but the display now shows project-wide total tokens (input + output)
  // across all sessions, which doesn't have a meaningful "limit"

  const modelDisplay = createMemo(() => {
    if (!props.providerId || !props.modelId) return "Select Model"
    // Shorten common provider names
    const shortProvider = props.providerId
      .replace("anthropic", "")
      .replace("openai", "")
      .replace("-", "")

    // If provider is empty after shortening, just show model
    if (!shortProvider) {
      return props.modelId
    }
    return `${props.providerId}/${props.modelId}`
  })

  // MCP server count - use prop if available (instance-specific), otherwise compute from preferences
  const mcpServerCount = createMemo(() => {
    // Use instance-specific count if provided
    if (props.mcpActiveCount !== undefined) {
      return props.mcpActiveCount
    }
    // Fallback to global count
    const registry = preferences().mcpRegistry || {}
    const desiredState = preferences().mcpDesiredState || {}
    let enabledCount = 0
    for (const [name, config] of Object.entries(registry)) {
      const isEnabled = desiredState[name] !== undefined
        ? desiredState[name]
        : config.enabled !== false
      if (isEnabled) enabledCount++
    }
    return enabledCount
  })

  const hasMcpServers = createMemo(() => {
    // If we have instance-specific count, use it
    if (props.mcpActiveCount !== undefined) {
      return true // Always show when instance-specific
    }
    return Object.keys(preferences().mcpRegistry || {}).length > 0
  })

  return (
    <div class="flex items-center h-7 px-2 text-xs bg-card border-t border-border text-muted-foreground flex-shrink-0">
      {/* Project name */}
      <div class={cn(itemBase, "flex-shrink-0")}>
        <Folder class={iconBase} />
        <span class={cn(textBase, "max-w-[150px]")}>{props.projectName}</span>
      </div>

      {/* Git status */}
      <Show when={props.gitBranch}>
        <div class={dividerClass} />
        <div class={cn(itemBase, "flex-shrink-0")} title={`Branch: ${props.gitBranch}`}>
          <GitBranch class={cn(iconBase, "text-info")} />
          <span class={cn(textBase, "max-w-[100px] font-mono")}>{props.gitBranch}</span>
          <Show when={(props.gitAhead ?? 0) > 0 || (props.gitBehind ?? 0) > 0}>
            <span class="flex items-center gap-1 ml-1">
              <Show when={(props.gitAhead ?? 0) > 0}>
                <span class="text-success font-medium">{"\u2191"}{props.gitAhead}</span>
              </Show>
              <Show when={(props.gitBehind ?? 0) > 0}>
                <span class="text-warning font-medium">{"\u2193"}{props.gitBehind}</span>
              </Show>
            </span>
          </Show>
        </div>
      </Show>

      <div class={dividerClass} />

      {/* Token usage - shows project total input and output across all sessions */}
      <button
        type="button"
        class={cn(itemButton, "flex-shrink-0 min-w-[140px]")}
        onClick={props.onContextClick}
        title="Total tokens across all sessions (\u2191 input  \u2193 output)"
      >
        <Show when={props.isCompacting}>
          <Loader2 class={cn(iconBase, "animate-spin")} />
          <span class={cn(textBase, "text-warning")}>Compacting...</span>
        </Show>
        <Show when={!props.isCompacting}>
          <span class={textBase}>
            <Show
              when={props.usedTokens > 0}
              fallback={<span class="text-muted-foreground">Tokens: --</span>}
            >
              {"\u2191"}{formatTokenTotal(props.inputTokens)} {"\u2193"}{formatTokenTotal(props.outputTokens)}
            </Show>
          </span>
        </Show>
      </button>

      <div class={dividerClass} />

      {/* Provider/Model selector */}
      <button
        type="button"
        class={cn(itemButton, "flex-shrink-0")}
        onClick={props.onModelClick}
      >
        <span class={cn(textBase, "max-w-[180px] font-mono")}>{modelDisplay()}</span>
      </button>

      {/* Cost - always show per spec */}
      <div class={dividerClass} />
      <button
        type="button"
        class={cn(itemButton, "flex-shrink-0 ml-auto")}
        onClick={props.onContextClick}
        title="Session cost"
      >
        <span class={cn(textBase, "font-mono min-w-[50px] text-right")}>{formatCost(props.cost)}</span>
      </button>

      {/* Governance indicator - only show when era is installed */}
      <Show when={isEraInstalled()}>
        <div class={dividerClass} />
        <button
          type="button"
          class={cn(itemButton, "flex-shrink-0")}
          onClick={() => props.onGovernanceClick?.()}
          title="Governance rules"
        >
          <Shield class={iconBase} />
          <Show when={governanceSummary()}>
            <span class={textBase}>
              {governanceSummary()!.totalRules}
              <Show when={activeOverridesCount() > 0}>
                <span class="text-success font-medium">
                  +{activeOverridesCount()}
                </span>
              </Show>
            </span>
          </Show>
        </button>
      </Show>

      {/* Directives indicator - only show when era is installed */}
      <Show when={isEraInstalled()}>
        <div class={dividerClass} />
        <button
          type="button"
          class={cn(itemButton, "flex-shrink-0")}
          onClick={() => props.onDirectivesClick?.()}
          title={hasProjectDirectives() ? "Project directives configured" : "No project directives"}
        >
          <FileText class={cn(iconBase, hasProjectDirectives() && "text-info")} />
          <span class={cn(textBase, hasProjectDirectives() ? "text-muted-foreground" : "text-muted-foreground")}>
            {hasProjectDirectives() ? "Directives" : "No Directives"}
          </span>
        </button>
      </Show>

      {/* MCP indicator */}
      <Show when={hasMcpServers() || props.onMcpClick}>
        <div class={dividerClass} />
        <button
          type="button"
          class={cn(itemButton, "flex-shrink-0")}
          onClick={() => props.onMcpClick?.()}
          title={`${mcpServerCount()} MCP server${mcpServerCount() !== 1 ? "s" : ""} active`}
        >
          <Plug class={cn(iconBase, mcpServerCount() > 0 && "text-success")} />
          <span class={textBase}>
            MCP
            <Show when={hasMcpServers()}>
              <span class={cn("font-medium ml-0.5", mcpServerCount() > 0 ? "text-success" : "text-muted-foreground")}>({mcpServerCount()})</span>
            </Show>
          </span>
        </button>
      </Show>

      {/* LSP indicator */}
      <Show when={props.lspTotal !== undefined && props.lspTotal > 0}>
        <div class={dividerClass} />
        <button
          type="button"
          class={cn(itemButton, "flex-shrink-0")}
          onClick={() => props.onLspClick?.()}
          title={`${props.lspConnected ?? 0} of ${props.lspTotal} LSP server${props.lspTotal !== 1 ? "s" : ""} connected`}
        >
          <Code2 class={cn(iconBase, (props.lspConnected ?? 0) > 0 && "text-success")} />
          <span class={textBase}>
            LSP
            <span class={cn("font-medium ml-0.5", (props.lspConnected ?? 0) > 0 ? "text-success" : "text-muted-foreground")}>({props.lspConnected ?? 0})</span>
          </span>
        </button>
      </Show>

      {/* Instance indicator */}
      <Show when={props.instancePort}>
        <div class={dividerClass} />
        <button
          type="button"
          class={cn(itemButton, "flex-shrink-0")}
          onClick={() => props.onInstanceClick?.()}
          title={`Instance running on port ${props.instancePort}`}
        >
          <Server class={cn(iconBase, "text-success")} />
          <span class={cn(textBase, "font-mono")}>
            :{props.instancePort}
          </span>
        </button>
      </Show>

      {/* Working indicator - shown when session is busy */}
      <Show when={props.isSessionBusy}>
        <div class={dividerClass} />
        <button
          type="button"
          class={cn(itemButton, "flex-shrink-0 gap-2 hover:text-foreground")}
          onClick={() => props.onInterrupt?.()}
          title="Click to interrupt (\u2318.)"
        >
          <Loader2 class={cn(iconBase, "animate-spin text-warning hover:text-foreground")} />
          <span class={cn(textBase, "text-warning font-medium")}>Working...</span>
          <span class="flex items-center text-xs">
            <span class="text-muted-foreground">({"\u2318"}. to interrupt</span>
            <Show when={props.elapsedSeconds !== undefined && props.elapsedSeconds > 0}>
              <span class="text-muted-foreground"> {"\u00B7"} {props.elapsedSeconds}s</span>
            </Show>
            <Show when={props.streamingTokens !== undefined && props.streamingTokens > 0}>
              <span class="text-muted-foreground"> {"\u00B7"} {"\u2193"}{formatTokenTotal(props.streamingTokens!)}</span>
            </Show>
            <span class="text-muted-foreground">)</span>
          </span>
        </button>
      </Show>

      {/* Spacer */}
      <div class="flex-1" />

      {/* Connection status indicator */}
      <Show when={props.connectionStatus}>
        <div class={dividerClass} />
        <div class={cn(itemBase, "flex-shrink-0")} title={`Connection: ${props.connectionStatus}`}>
          <Show when={props.connectionStatus === "connected"}>
            <span class="w-2 h-2 rounded-full bg-success flex-shrink-0" />
          </Show>
          <Show when={props.connectionStatus === "connecting"}>
            <span class="w-2 h-2 rounded-full bg-warning animate-pulse flex-shrink-0" />
            <span class={textBase}>Connecting...</span>
          </Show>
          <Show when={props.connectionStatus === "disconnected" || props.connectionStatus === "error"}>
            <span class="w-2 h-2 rounded-full bg-destructive flex-shrink-0" />
            <span class={textBase}>Disconnected</span>
          </Show>
        </div>
      </Show>

      {/* Settings */}
      <div class={dividerClass} />
      <button
        type="button"
        class={cn(itemButton, "flex-shrink-0 gap-1")}
        onClick={() => props.onSettingsClick?.()}
        title="Settings"
      >
        <Settings class={iconBase} />
      </button>
    </div>
  )
}

export default BottomStatusBar
