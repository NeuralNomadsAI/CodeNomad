import { type JSX, splitProps } from "solid-js"
import { Checkbox as KobalteCheckbox } from "@kobalte/core/checkbox"
import { cn } from "../../lib/cn"

interface CheckboxProps {
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

function Checkbox(props: CheckboxProps) {
  const [local] = splitProps(props, [
    "class", "checked", "defaultChecked", "onChange", "disabled", "required", "name", "value", "label", "children"
  ])

  return (
    <KobalteCheckbox
      class={cn("inline-flex items-center", local.class)}
      checked={local.checked}
      defaultChecked={local.defaultChecked}
      onChange={local.onChange}
      disabled={local.disabled}
      name={local.name}
      value={local.value}
    >
      <KobalteCheckbox.Input class="peer" />
      <KobalteCheckbox.Control
        class={cn(
          "peer h-4 w-4 shrink-0 rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-primary data-[checked]:text-primary-foreground"
        )}
      >
        <KobalteCheckbox.Indicator class="flex items-center justify-center text-current">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </KobalteCheckbox.Indicator>
      </KobalteCheckbox.Control>
      {local.label && (
        <KobalteCheckbox.Label class="ml-2 text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          {local.label}
        </KobalteCheckbox.Label>
      )}
      {local.children}
    </KobalteCheckbox>
  )
}

export { Checkbox }
export type { CheckboxProps }
