import { type JSX, splitProps } from "solid-js"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { cn } from "../../lib/cn"

const Popover = KobaltePopover
const PopoverTrigger = KobaltePopover.Trigger
const PopoverAnchor = KobaltePopover.Anchor

function PopoverContent(props: JSX.HTMLAttributes<HTMLDivElement> & { align?: string; sideOffset?: number }) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobaltePopover.Portal>
      <KobaltePopover.Content
        class={cn(
          "z-50 w-72 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95",
          local.class
        )}
        {...rest}
      >
        {local.children}
      </KobaltePopover.Content>
    </KobaltePopover.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent }
