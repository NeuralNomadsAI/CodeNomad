import { Show } from "solid-js"
import Kbd from "./kbd"
import { useI18n } from "../lib/i18n"

const METRIC_CHIP_CLASS = "inline-flex items-center gap-1 rounded-full border border-base px-2 py-0.5 text-xs text-primary"
const METRIC_LABEL_CLASS = "uppercase text-[10px] tracking-wide text-muted"

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
  const { t } = useI18n()

  const hasAvailableTokens = () => typeof props.availableTokens === "number"
  const availableDisplay = () => (hasAvailableTokens() ? props.formatTokens(props.availableTokens as number) : "--")

  return (
    <div class={props.forceCompactStatusLayout ? "connection-status connection-status--compact" : "connection-status"}>
      <Show when={props.showSidebarToggle}>
        <div class="connection-status-menu">
          <button
            type="button"
            class="session-sidebar-menu-button"
            onClick={() => props.onSidebarToggle?.()}
            aria-label={t("messageListHeader.sidebar.openSessionListAriaLabel")}
          >
            <span aria-hidden="true" class="session-sidebar-menu-icon">☰</span>
          </button>
        </div>
      </Show>

      <div class="connection-status-text connection-status-info">
        <div class="connection-status-usage">
          <div class={METRIC_CHIP_CLASS}>
            <span class={METRIC_LABEL_CLASS}>{t("messageListHeader.metrics.usedLabel")}</span>
            <span class="font-semibold text-primary">{props.formatTokens(props.usedTokens)}</span>
          </div>
          <div class={METRIC_CHIP_CLASS}>
            <span class={METRIC_LABEL_CLASS}>{t("messageListHeader.metrics.availableLabel")}</span>
            <span class="font-semibold text-primary">{hasAvailableTokens() ? availableDisplay() : "--"}</span>
          </div>
        </div>
      </div>

      <div class="connection-status-text connection-status-shortcut">
        <div class="connection-status-shortcut-action">
          <button
            type="button"
            class="connection-status-button"
            onClick={props.onCommandPalette}
            aria-label={t("messageListHeader.commandPalette.ariaLabel")}
          >
            {t("messageListHeader.commandPalette.button")}
          </button>
          <span class="connection-status-shortcut-hint">
            <Kbd shortcut="cmd+shift+p" class="kbd-hint" />
          </span>
        </div>
      </div>

      <div class="connection-status-meta flex items-center justify-end gap-3">
        <Show when={props.connectionStatus === "connected"}>
          <span class="status-indicator connected">
            <span class="status-dot" />
            <span class="status-text">{t("messageListHeader.connection.connected")}</span>
          </span>
        </Show>
        <Show when={props.connectionStatus === "connecting"}>
          <span class="status-indicator connecting">
            <span class="status-dot" />
            <span class="status-text">{t("messageListHeader.connection.connecting")}</span>
          </span>
        </Show>
        <Show when={props.connectionStatus === "error" || props.connectionStatus === "disconnected"}>
          <span class="status-indicator disconnected">
            <span class="status-dot" />
            <span class="status-text">{t("messageListHeader.connection.disconnected")}</span>
          </span>
        </Show>
      </div>
    </div>
  )
}
