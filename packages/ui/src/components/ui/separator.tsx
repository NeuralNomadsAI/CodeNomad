import { type JSX, splitProps } from "solid-js"
import { cn } from "../../lib/cn"

interface SeparatorProps extends JSX.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical"
  decorative?: boolean
}

function Separator(props: SeparatorProps) {
  const [local, rest] = splitProps(props, ["class", "orientation", "decorative", "children"])
  const orientation = () => local.orientation ?? "horizontal"

  return (
    <div
      role={local.decorative ? "none" : "separator"}
      aria-orientation={!local.decorative ? orientation() : undefined}
      class={cn(
        "shrink-0 bg-border",
        orientation() === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
        local.class
      )}
      {...rest}
    />
  )
}

export { Separator }
export type { SeparatorProps }
