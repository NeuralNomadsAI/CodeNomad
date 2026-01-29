import { Component, Show, createMemo } from "solid-js"
import { Folder, Loader2, Shield, FileText, Plug, Server, Settings, Code2, GitBranch } from "lucide-solid"
import { formatTokenTotal, formatCost } from "../lib/formatters"
import { isEraInstalled } from "../stores/era-status"
import { governanceSummary, activeOverridesCount } from "../stores/era-governance"
import { hasProjectDirectives } from "../stores/era-directives"
import { preferences } from "../stores/preferences"

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
  // Working/busy state
  isSessionBusy?: boolean
  elapsedSeconds?: number
  streamingTokens?: number
  onInterrupt?: () => void
}

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
    <div class="bottom-status-bar">
      {/* Project name */}
      <div class="bottom-status-item bottom-status-project">
        <Folder class="bottom-status-icon" />
        <span class="bottom-status-text">{props.projectName}</span>
      </div>

      {/* Git status */}
      <Show when={props.gitBranch}>
        <div class="bottom-status-divider" />
        <div class="bottom-status-item bottom-status-git" title={`Branch: ${props.gitBranch}`}>
          <GitBranch class="bottom-status-icon" />
          <span class="bottom-status-text">{props.gitBranch}</span>
          <Show when={(props.gitAhead ?? 0) > 0 || (props.gitBehind ?? 0) > 0}>
            <span class="bottom-status-git-sync">
              <Show when={(props.gitAhead ?? 0) > 0}>
                <span class="bottom-status-git-ahead">↑{props.gitAhead}</span>
              </Show>
              <Show when={(props.gitBehind ?? 0) > 0}>
                <span class="bottom-status-git-behind">↓{props.gitBehind}</span>
              </Show>
            </span>
          </Show>
        </div>
      </Show>

      <div class="bottom-status-divider" />

      {/* Token usage - shows project total input and output across all sessions */}
      <button
        type="button"
        class="bottom-status-item bottom-status-context"
        onClick={props.onContextClick}
        title="Total tokens across all sessions (↑ input  ↓ output)"
      >
        <Show when={props.isCompacting}>
          <Loader2 class="bottom-status-icon bottom-status-spinner" />
          <span class="bottom-status-text bottom-status-compacting">Compacting...</span>
        </Show>
        <Show when={!props.isCompacting}>
          <span class="bottom-status-text">
            <Show
              when={props.usedTokens > 0}
              fallback={<span class="bottom-status-muted">Tokens: --</span>}
            >
              ↑{formatTokenTotal(props.inputTokens)} ↓{formatTokenTotal(props.outputTokens)}
            </Show>
          </span>
        </Show>
      </button>

      <div class="bottom-status-divider" />

      {/* Provider/Model selector */}
      <button
        type="button"
        class="bottom-status-item bottom-status-model"
        onClick={props.onModelClick}
      >
        <span class="bottom-status-text">{modelDisplay()}</span>
      </button>

      {/* Cost - always show per spec */}
      <div class="bottom-status-divider" />
      <button
        type="button"
        class="bottom-status-item bottom-status-cost"
        onClick={props.onContextClick}
        title="Session cost"
      >
        <span class="bottom-status-text">{formatCost(props.cost)}</span>
      </button>

      {/* Governance indicator - only show when era is installed */}
      <Show when={isEraInstalled()}>
        <div class="bottom-status-divider" />
        <button
          type="button"
          class="bottom-status-item bottom-status-governance"
          onClick={() => props.onGovernanceClick?.()}
          title="Governance rules"
        >
          <Shield class="bottom-status-icon" />
          <Show when={governanceSummary()}>
            <span class="bottom-status-text">
              {governanceSummary()!.totalRules}
              <Show when={activeOverridesCount() > 0}>
                <span class="bottom-status-governance-overrides">
                  +{activeOverridesCount()}
                </span>
              </Show>
            </span>
          </Show>
        </button>
      </Show>

      {/* Directives indicator - only show when era is installed */}
      <Show when={isEraInstalled()}>
        <div class="bottom-status-divider" />
        <button
          type="button"
          class={`bottom-status-item bottom-status-directives ${hasProjectDirectives() ? "has-directives" : ""}`}
          onClick={() => props.onDirectivesClick?.()}
          title={hasProjectDirectives() ? "Project directives configured" : "No project directives"}
        >
          <FileText class="bottom-status-icon" />
          <span class="bottom-status-text">
            {hasProjectDirectives() ? "Directives" : "No Directives"}
          </span>
        </button>
      </Show>

      {/* MCP indicator */}
      <Show when={hasMcpServers() || props.onMcpClick}>
        <div class="bottom-status-divider" />
        <button
          type="button"
          class={`bottom-status-item bottom-status-mcp ${mcpServerCount() > 0 ? "has-servers" : ""}`}
          onClick={() => props.onMcpClick?.()}
          title={`${mcpServerCount()} MCP server${mcpServerCount() !== 1 ? "s" : ""} active`}
        >
          <Plug class="bottom-status-icon" />
          <span class="bottom-status-text">
            MCP
            <Show when={hasMcpServers()}>
              <span class="bottom-status-count">({mcpServerCount()})</span>
            </Show>
          </span>
        </button>
      </Show>

      {/* LSP indicator */}
      <Show when={props.lspTotal !== undefined && props.lspTotal > 0}>
        <div class="bottom-status-divider" />
        <button
          type="button"
          class={`bottom-status-item bottom-status-lsp ${(props.lspConnected ?? 0) > 0 ? "has-servers" : ""}`}
          onClick={() => props.onLspClick?.()}
          title={`${props.lspConnected ?? 0} of ${props.lspTotal} LSP server${props.lspTotal !== 1 ? "s" : ""} connected`}
        >
          <Code2 class="bottom-status-icon" />
          <span class="bottom-status-text">
            LSP
            <span class="bottom-status-count">({props.lspConnected ?? 0})</span>
          </span>
        </button>
      </Show>

      {/* Instance indicator */}
      <Show when={props.instancePort}>
        <div class="bottom-status-divider" />
        <button
          type="button"
          class="bottom-status-item bottom-status-instance"
          onClick={() => props.onInstanceClick?.()}
          title={`Instance running on port ${props.instancePort}`}
        >
          <Server class="bottom-status-icon" />
          <span class="bottom-status-text">
            :{props.instancePort}
          </span>
        </button>
      </Show>

      {/* Working indicator - shown when session is busy */}
      <Show when={props.isSessionBusy}>
        <div class="bottom-status-divider" />
        <button
          type="button"
          class="bottom-status-item bottom-status-working"
          onClick={() => props.onInterrupt?.()}
          title="Click to interrupt (⌘.)"
        >
          <Loader2 class="bottom-status-icon bottom-status-spinner" />
          <span class="bottom-status-text">Working...</span>
          <span class="bottom-status-interrupt-hint">
            <span class="bottom-status-muted">(⌘. to interrupt</span>
            <Show when={props.elapsedSeconds !== undefined && props.elapsedSeconds > 0}>
              <span class="bottom-status-muted"> · {props.elapsedSeconds}s</span>
            </Show>
            <Show when={props.streamingTokens !== undefined && props.streamingTokens > 0}>
              <span class="bottom-status-muted"> · ↓{formatTokenTotal(props.streamingTokens!)}</span>
            </Show>
            <span class="bottom-status-muted">)</span>
          </span>
        </button>
      </Show>

      {/* Settings + Status indicator (per spec) */}
      <div class="bottom-status-spacer" />
      <div class="bottom-status-divider" />
      <button
        type="button"
        class="bottom-status-item bottom-status-settings"
        onClick={() => props.onSettingsClick?.()}
        title="Settings"
      >
        <Settings class="bottom-status-icon" />
        <span class="bottom-status-status-dot" />
      </button>
    </div>
  )
}

export default BottomStatusBar
