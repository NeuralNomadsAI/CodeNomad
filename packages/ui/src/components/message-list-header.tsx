import { Show } from "solid-js"
import Kbd from "./kbd"
import ContextProgressBar from "./context-progress-bar"
import { cn } from "../lib/cn"
import { Button } from "./ui"

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
    <div
      class={cn(
        "grid items-center px-4 py-2 gap-4 bg-secondary border-b border-border",
        props.forceCompactStatusLayout
          ? "grid-cols-[auto_1fr_auto] [grid-template-areas:'menu_shortcut_meta'_'info_info_info'] gap-y-2"
          : "grid-cols-[1fr_auto_1fr] [grid-template-areas:'info_shortcut_meta']"
      )}
    >
      <Show when={props.showSidebarToggle}>
        <div class={cn(
          "[grid-area:menu]",
          props.forceCompactStatusLayout ? "flex items-center justify-start" : "hidden"
        )}>
          <button
            type="button"
            class="inline-flex items-center justify-center border border-border rounded-md px-2 py-1 text-sm font-medium bg-transparent text-foreground transition-colors duration-200 hover:bg-accent focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-primary"
            onClick={() => props.onSidebarToggle?.()}
            aria-label="Open session list"
          >
            <span aria-hidden="true" class="text-base leading-none">&#9776;</span>
          </button>
        </div>
      </Show>

      <div class="[grid-area:info] justify-self-center text-center text-muted-foreground flex flex-wrap items-center gap-3 text-sm font-medium">
        <div class="flex flex-wrap items-center justify-center gap-2 text-xs text-foreground">
          <ContextProgressBar
            usedTokens={props.usedTokens}
            availableTokens={props.availableTokens}
            formatTokens={props.formatTokens}
            compact={props.forceCompactStatusLayout}
          />
        </div>
      </div>

      <div class="[grid-area:shortcut] justify-self-center text-center text-muted-foreground">
        <div class="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={props.onCommandPalette}
            aria-label="Open command palette"
          >
            Command Palette
          </Button>
          <span class="inline-flex items-center text-secondary-foreground pointer-coarse:hidden">
            <Kbd shortcut="cmd+shift+p" />
          </span>
        </div>
      </div>

      <div class="[grid-area:meta] justify-self-end flex items-center justify-end gap-3">
        <Show when={props.connectionStatus === "connected"}>
          <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span class="w-2 h-2 rounded-full bg-success" />
            <span class="inline-block lg:inline">Connected</span>
          </span>
        </Show>
        <Show when={props.connectionStatus === "connecting"}>
          <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span class="w-2 h-2 rounded-full bg-warning" />
            <span class="inline-block lg:inline">Connecting...</span>
          </span>
        </Show>
        <Show when={props.connectionStatus === "error" || props.connectionStatus === "disconnected"}>
          <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span class="w-2 h-2 rounded-full bg-destructive" />
            <span class="inline-block lg:inline">Disconnected</span>
          </span>
        </Show>
      </div>
    </div>
  )
}
