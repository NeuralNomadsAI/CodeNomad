import { type JSX, splitProps, Show, createSignal } from "solid-js"
import { cn } from "../../lib/cn"

interface TooltipProps {
  content: JSX.Element
  children: JSX.Element
  class?: string
  side?: "top" | "bottom" | "left" | "right"
  delayMs?: number
}

function Tooltip(props: TooltipProps) {
  const [local] = splitProps(props, ["content", "children", "class", "side", "delayMs"])
  const [open, setOpen] = createSignal(false)
  let timeout: ReturnType<typeof setTimeout> | undefined

  const side = () => local.side ?? "top"
  const delay = () => local.delayMs ?? 300

  const handleEnter = () => {
    timeout = setTimeout(() => setOpen(true), delay())
  }

  const handleLeave = () => {
    if (timeout) clearTimeout(timeout)
    setOpen(false)
  }

  const positionClass = () => {
    switch (side()) {
      case "top": return "bottom-full left-1/2 -translate-x-1/2 mb-2"
      case "bottom": return "top-full left-1/2 -translate-x-1/2 mt-2"
      case "left": return "right-full top-1/2 -translate-y-1/2 mr-2"
      case "right": return "left-full top-1/2 -translate-y-1/2 ml-2"
    }
  }

  return (
    <div
      class="relative inline-flex"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onFocusIn={handleEnter}
      onFocusOut={handleLeave}
    >
      {local.children}
      <Show when={open()}>
        <div
          class={cn(
            "absolute z-50 overflow-hidden rounded-md bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95",
            positionClass(),
            local.class
          )}
          role="tooltip"
        >
          {local.content}
        </div>
      </Show>
    </div>
  )
}

export { Tooltip }
export type { TooltipProps }
