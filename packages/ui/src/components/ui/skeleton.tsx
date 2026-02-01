import { type JSX, splitProps } from "solid-js"
import { cn } from "../../lib/cn"

function Skeleton(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"])
  return (
    <div
      class={cn("animate-pulse rounded-md bg-muted", local.class)}
      {...rest}
    />
  )
}

export { Skeleton }
