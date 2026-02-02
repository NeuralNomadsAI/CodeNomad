import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { MessageSquare, Layers, LayoutDashboard, Settings } from "lucide-solid"
import { activeMobileTab, setActiveMobileTab, type MobileTab } from "../../stores/mobile-nav"
import { cn } from "../../lib/cn"

interface MobileBottomNavProps {
  chatBadge?: boolean
  sessionsBadge?: number
  workBadge?: number
  settingsBadge?: boolean
}

const tabs: { id: MobileTab; label: string; Icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", Icon: MessageSquare },
  { id: "sessions", label: "Sessions", Icon: Layers },
  { id: "work", label: "Work", Icon: LayoutDashboard },
  { id: "settings", label: "Settings", Icon: Settings },
]

const MobileBottomNav: Component<MobileBottomNavProps> = (props) => {
  const [keyboardOpen, setKeyboardOpen] = createSignal(false)

  createEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return

    const vv = window.visualViewport
    const initialHeight = vv.height

    const onResize = () => {
      // If viewport height shrinks by more than 150px, keyboard is likely open
      setKeyboardOpen(initialHeight - vv.height > 150)
    }

    vv.addEventListener("resize", onResize)
    onCleanup(() => vv.removeEventListener("resize", onResize))
  })

  const getBadge = (tab: MobileTab) => {
    switch (tab) {
      case "chat":
        return props.chatBadge ? "dot" : null
      case "sessions":
        return (props.sessionsBadge ?? 0) > 0 ? props.sessionsBadge : null
      case "work":
        return (props.workBadge ?? 0) > 0 ? props.workBadge : null
      case "settings":
        return props.settingsBadge ? "dot" : null
      default:
        return null
    }
  }

  return (
    <nav
      data-mobile-bottom-nav
      class={cn(
        "shrink-0 bg-card border-t border-border transition-transform duration-150 ease-out",
        keyboardOpen() && "translate-y-full pointer-events-none"
      )}
      style={{ "padding-bottom": "env(safe-area-inset-bottom, 0px)" }}
    >
      <div class="flex items-center h-14">
        <For each={tabs}>
          {(tab) => {
            const isActive = () => activeMobileTab() === tab.id
            const badge = () => getBadge(tab.id)

            return (
              <button
                type="button"
                data-tab={tab.id}
                class={cn(
                  "flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[48px] transition-colors relative",
                  isActive() ? "text-info" : "text-muted-foreground"
                )}
                onClick={() => {
                  // Tapping the active Chat tab scrolls to bottom
                  if (tab.id === "chat" && isActive()) {
                    const event = new CustomEvent("mobile-chat-scroll-bottom")
                    window.dispatchEvent(event)
                    return
                  }
                  setActiveMobileTab(tab.id)
                }}
              >
                {/* Active indicator bar */}
                <span
                  class={cn(
                    "absolute top-0 left-1/2 -translate-x-1/2 h-[2px] rounded-full transition-all duration-200",
                    isActive() ? "w-8 bg-info" : "w-0 bg-transparent"
                  )}
                />
                <div class="relative">
                  <tab.Icon class={cn("w-5 h-5", isActive() && "stroke-[2.5px]")} />
                  <Show when={badge() !== null}>
                    <Show
                      when={badge() === "dot"}
                      fallback={
                        <span class="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center">
                          {badge()}
                        </span>
                      }
                    >
                      <span class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-destructive" />
                    </Show>
                  </Show>
                </div>
                <span class={cn(
                  "text-[11px] leading-none transition-all duration-200",
                  isActive() ? "font-semibold" : "font-medium"
                )}>
                  {tab.label}
                </span>
              </button>
            )
          }}
        </For>
      </div>
    </nav>
  )
}

export default MobileBottomNav
