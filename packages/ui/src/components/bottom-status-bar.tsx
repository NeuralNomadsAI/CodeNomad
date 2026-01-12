import { Component, Show, createMemo } from "solid-js"
import { Folder, Loader2 } from "lucide-solid"
import { formatTokenTotal, formatCost } from "../lib/formatters"

interface BottomStatusBarProps {
  projectName: string
  usedTokens: number
  availableTokens: number | null
  contextWindow: number
  isCompacting: boolean
  providerId: string
  modelId: string
  cost: number
  onModelClick: () => void
  onContextClick: () => void
}

const BottomStatusBar: Component<BottomStatusBarProps> = (props) => {
  const total = createMemo(() => {
    if (props.availableTokens === null) return props.contextWindow || null
    return props.usedTokens + props.availableTokens
  })

  const percentage = createMemo(() => {
    const t = total()
    if (t === null || t === 0) return 0
    return Math.min((props.usedTokens / t) * 100, 100)
  })

  const usageLevel = createMemo(() => {
    const pct = percentage()
    if (pct >= 90) return "critical"
    if (pct >= 75) return "warning"
    return "normal"
  })

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

  return (
    <div class="bottom-status-bar">
      {/* Project name */}
      <div class="bottom-status-item bottom-status-project">
        <Folder class="bottom-status-icon" />
        <span class="bottom-status-text">{props.projectName}</span>
      </div>

      <div class="bottom-status-divider" />

      {/* Context usage with progress bar */}
      <button
        type="button"
        class="bottom-status-item bottom-status-context"
        onClick={props.onContextClick}
        title="Context window usage (tokens used / total available)"
      >
        <Show when={props.isCompacting}>
          <Loader2 class="bottom-status-icon bottom-status-spinner" />
          <span class="bottom-status-text bottom-status-compacting">Compacting...</span>
        </Show>
        <Show when={!props.isCompacting}>
          {/* Only show progress bar when we have data */}
          <Show when={total() !== null && total()! > 0}>
            <div class="bottom-status-context-bar">
              <div class="bottom-status-context-track">
                <div
                  class={`bottom-status-context-fill bottom-status-context-fill--${usageLevel()}`}
                  style={{ width: `${percentage()}%` }}
                />
              </div>
            </div>
          </Show>
          <span class="bottom-status-text">
            <Show
              when={total() !== null && total()! > 0}
              fallback={<span class="bottom-status-muted">Context: --</span>}
            >
              {formatTokenTotal(props.usedTokens)}
              <span class="bottom-status-muted">
                {" / "}
                {formatTokenTotal(total()!)}
              </span>
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

      {/* Cost - only show when there's actual cost data */}
      <Show when={props.cost > 0}>
        <div class="bottom-status-divider" />
        <button
          type="button"
          class="bottom-status-item bottom-status-cost"
          onClick={props.onContextClick}
          title="Session cost"
        >
          <span class="bottom-status-text">{formatCost(props.cost)}</span>
        </button>
      </Show>
    </div>
  )
}

export default BottomStatusBar
