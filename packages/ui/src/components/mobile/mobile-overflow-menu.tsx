import { Component, Show, createSignal, createEffect, onCleanup } from "solid-js"
import { Command, Info, FolderOpen } from "lucide-solid"
import { cn } from "../../lib/cn"

interface MobileOverflowMenuProps {
  open: boolean
  onClose: () => void
  onCommandPalette: () => void
  onInstanceInfo: () => void
  onSwitchProject: () => void
}

const menuItemClass =
  "flex items-center gap-3 w-full px-4 py-3 min-h-[48px] text-sm text-foreground hover:bg-accent active:bg-accent/80 transition-colors text-left focus:outline-none focus-visible:bg-accent"

const MobileOverflowMenu: Component<MobileOverflowMenuProps> = (props) => {
  const [visible, setVisible] = createSignal(false)
  const [animating, setAnimating] = createSignal(false)
  let menuRef: HTMLDivElement | undefined
  let firstButtonRef: HTMLButtonElement | undefined

  // Animate in when opening, animate out when closing
  createEffect(() => {
    if (props.open) {
      setVisible(true)
      // Trigger reflow before adding animating class for CSS transition
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setAnimating(true)
          // Focus first item for accessibility
          firstButtonRef?.focus()
        })
      })
    } else if (visible()) {
      setAnimating(false)
      const timer = setTimeout(() => setVisible(false), 150)
      onCleanup(() => clearTimeout(timer))
    }
  })

  // Handle Escape key
  createEffect(() => {
    if (!props.open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        props.onClose()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
  })

  return (
    <Show when={visible()}>
      {/* Backdrop */}
      <div class="fixed inset-0 z-50" onClick={props.onClose} role="presentation" />
      {/* Menu */}
      <div
        ref={menuRef}
        role="menu"
        class={cn(
          "fixed right-2 z-50 w-56 rounded-lg border border-border bg-card shadow-xl overflow-hidden origin-top-right transition-all duration-150 ease-out",
          animating() ? "opacity-100 scale-100" : "opacity-0 scale-95"
        )}
        style={{ top: "calc(44px + env(safe-area-inset-top, 0px) + 4px)" }}
      >
        <button
          ref={firstButtonRef}
          type="button"
          role="menuitem"
          class={menuItemClass}
          onClick={() => { props.onCommandPalette(); props.onClose() }}
        >
          <Command class="w-4 h-4 text-muted-foreground" />
          Command Palette
        </button>
        <button
          type="button"
          role="menuitem"
          class={menuItemClass}
          onClick={() => { props.onInstanceInfo(); props.onClose() }}
        >
          <Info class="w-4 h-4 text-muted-foreground" />
          Instance Info
        </button>
        <button
          type="button"
          role="menuitem"
          class={cn(menuItemClass, "border-t border-border")}
          onClick={() => { props.onSwitchProject(); props.onClose() }}
        >
          <FolderOpen class="w-4 h-4 text-muted-foreground" />
          Switch Project
        </button>
      </div>
    </Show>
  )
}

export default MobileOverflowMenu
