import { type JSX, splitProps } from "solid-js"
import { Switch as KobalteSwitch } from "@kobalte/core/switch"
import { cn } from "../../lib/cn"

interface SwitchProps {
  checked?: boolean
  defaultChecked?: boolean
  onChange?: (checked: boolean) => void
  disabled?: boolean
  required?: boolean
  name?: string
  value?: string
  label?: string
  class?: string
  children?: JSX.Element
}

function Switch(props: SwitchProps) {
  const [local] = splitProps(props, [
    "class", "checked", "defaultChecked", "onChange", "disabled", "required", "name", "value", "label", "children"
  ])

  return (
    <KobalteSwitch
      class={cn("inline-flex items-center", local.class)}
      checked={local.checked}
      defaultChecked={local.defaultChecked}
      onChange={local.onChange}
      disabled={local.disabled}
      name={local.name}
      value={local.value}
    >
      <KobalteSwitch.Input class="peer" />
      <KobalteSwitch.Control
        class={cn(
          "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-primary data-[unchecked]:bg-input"
        )}
      >
        <KobalteSwitch.Thumb
          class={cn(
            "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[checked]:translate-x-4 data-[unchecked]:translate-x-0"
          )}
        />
      </KobalteSwitch.Control>
      {local.label && (
        <KobalteSwitch.Label class="ml-2 text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          {local.label}
        </KobalteSwitch.Label>
      )}
      {local.children}
    </KobalteSwitch>
  )
}

export { Switch }
export type { SwitchProps }
