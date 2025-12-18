import { Show } from "solid-js"
import Kbd from "./kbd"
import ContextProgressBar from "./context-progress-bar"

interface MessageListHeaderProps {
  usedTokens: number
  availableTokens?: number | null
  connectionStatus: "connected" | "connecting" | "error" | "disconnected" | "unknown" | null
  onCommandPalette: () => void
  formatTokens: (value: number) => string
  showSidebarToggle?: boolean
  onSidebarToggle?: () => void
  forceCompactStatusLayout?: boolean
}

export default function MessageListHeader(props: MessageListHeaderProps) {
  return (
    <div class={props.forceCompactStatusLayout ? "connection-status connection-status--compact" : "connection-status"}>
      <Show when={props.showSidebarToggle}>
        <div class="connection-status-menu">
          <button
            type="button"
            class="session-sidebar-menu-button"
            onClick={() => props.onSidebarToggle?.()}
            aria-label="Open session list"
          >
            <span aria-hidden="true" class="session-sidebar-menu-icon">☰</span>
          </button>
        </div>
      </Show>

      <div class="connection-status-text connection-status-info">
        <div class="connection-status-usage">
          <ContextProgressBar
            usedTokens={props.usedTokens}
            availableTokens={props.availableTokens}
            formatTokens={props.formatTokens}
            compact={props.forceCompactStatusLayout}
          />
        </div>
      </div>

      <div class="connection-status-text connection-status-shortcut">
        <div class="connection-status-shortcut-action">
          <button type="button" class="connection-status-button" onClick={props.onCommandPalette} aria-label="Open command palette">
            Command Palette
          </button>
          <span class="connection-status-shortcut-hint">
            <Kbd shortcut="cmd+shift+p" />
          </span>
        </div>
      </div>

      <div class="connection-status-meta flex items-center justify-end gap-3">
        <Show when={props.connectionStatus === "connected"}>
          <span class="status-indicator connected">
            <span class="status-dot" />
            <span class="status-text">Connected</span>
          </span>
        </Show>
        <Show when={props.connectionStatus === "connecting"}>
          <span class="status-indicator connecting">
            <span class="status-dot" />
            <span class="status-text">Connecting...</span>
          </span>
        </Show>
        <Show when={props.connectionStatus === "error" || props.connectionStatus === "disconnected"}>
          <span class="status-indicator disconnected">
            <span class="status-dot" />
            <span class="status-text">Disconnected</span>
          </span>
        </Show>
      </div>
    </div>
  )
}
