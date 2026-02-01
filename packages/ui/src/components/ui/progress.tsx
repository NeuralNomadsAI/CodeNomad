import { type JSX, splitProps } from "solid-js"
import { cn } from "../../lib/cn"

interface ProgressProps extends JSX.HTMLAttributes<HTMLDivElement> {
  value?: number
  max?: number
  indicatorClass?: string
}

function Progress(props: ProgressProps) {
  const [local, rest] = splitProps(props, ["class", "value", "max", "indicatorClass", "children"])
  const max = () => local.max ?? 100
  const percentage = () => Math.min(100, Math.max(0, ((local.value ?? 0) / max()) * 100))

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max()}
      aria-valuenow={local.value ?? 0}
      class={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/20", local.class)}
      {...rest}
    >
      <div
        class={cn(
          "h-full w-full flex-1 bg-primary transition-all duration-300",
          local.indicatorClass
        )}
        style={{ transform: `translateX(-${100 - percentage()}%)` }}
      />
    </div>
  )
}

export { Progress }
export type { ProgressProps }
