import { type JSX, splitProps } from "solid-js"
import { cn } from "../../lib/cn"

type LabelProps = JSX.LabelHTMLAttributes<HTMLLabelElement>

function Label(props: LabelProps) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <label
      class={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        local.class
      )}
      {...rest}
    >
      {local.children}
    </label>
  )
}

export { Label }
export type { LabelProps }
