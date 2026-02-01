import { type JSX, splitProps } from "solid-js"
import { cn } from "../../lib/cn"

interface ScrollAreaProps extends JSX.HTMLAttributes<HTMLDivElement> {
  orientation?: "vertical" | "horizontal" | "both"
}

function ScrollArea(props: ScrollAreaProps) {
  const [local, rest] = splitProps(props, ["class", "children", "orientation"])
  const orientation = () => local.orientation ?? "vertical"

  return (
    <div
      class={cn(
        "relative",
        orientation() === "vertical" && "overflow-y-auto overflow-x-hidden",
        orientation() === "horizontal" && "overflow-x-auto overflow-y-hidden",
        orientation() === "both" && "overflow-auto",
        // Custom scrollbar styling
        "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:h-2",
        "[&::-webkit-scrollbar-track]:bg-transparent",
        "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border",
        "[&::-webkit-scrollbar-thumb]:hover:bg-muted-foreground/30",
        local.class
      )}
      {...rest}
    >
      {local.children}
    </div>
  )
}

export { ScrollArea }
export type { ScrollAreaProps }
