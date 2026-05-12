import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { For, Show, type JSXElement } from "solid-js"
import { MoreHorizontal } from "lucide-solid"

export interface ActionOverflowMenuItem {
  key: string
  label: string
  icon?: JSXElement
  disabled?: boolean
  destructive?: boolean
  onSelect: () => void | Promise<void>
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

interface ActionOverflowMenuProps {
  items: ActionOverflowMenuItem[]
  label: string
  triggerClass?: string
  minItems?: number
}

export default function ActionOverflowMenu(props: ActionOverflowMenuProps) {
  const enabledItems = () => props.items.filter((item) => !item.disabled)
  const hasItems = () => props.items.length >= (props.minItems ?? 1)

  return (
    <Show when={hasItems()}>
      <DropdownMenu placement="bottom-end" gutter={4}>
        <DropdownMenu.Trigger
          class={`action-overflow-trigger ${props.triggerClass ?? ""}`.trim()}
          aria-label={props.label}
          title={props.label}
          disabled={enabledItems().length === 0}
        >
          <MoreHorizontal class="w-3.5 h-3.5" aria-hidden="true" />
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content class="action-overflow-content">
            <For each={props.items}>
              {(item) => (
                <DropdownMenu.Item
                  class="action-overflow-item"
                  data-destructive={item.destructive ? "true" : undefined}
                  disabled={item.disabled}
                  onPointerEnter={() => item.onMouseEnter?.()}
                  onPointerLeave={() => item.onMouseLeave?.()}
                  onSelect={() => {
                    item.onMouseLeave?.()
                    void item.onSelect()
                  }}
                >
                  <Show when={item.icon} fallback={<span class="action-overflow-item-icon" aria-hidden="true" />}>
                    {(icon) => <span class="action-overflow-item-icon" aria-hidden="true">{icon()}</span>}
                  </Show>
                  <span class="action-overflow-item-label">{item.label}</span>
                </DropdownMenu.Item>
              )}
            </For>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}
