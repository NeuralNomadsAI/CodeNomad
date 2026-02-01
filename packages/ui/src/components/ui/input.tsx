import { type JSX, splitProps } from "solid-js"
import { cn } from "../../lib/cn"

type InputProps = JSX.InputHTMLAttributes<HTMLInputElement>

function Input(props: InputProps) {
  const [local, rest] = splitProps(props, ["class", "type"])
  return (
    <input
      type={local.type}
      class={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        local.class
      )}
      {...rest}
    />
  )
}

export { Input }
export type { InputProps }
