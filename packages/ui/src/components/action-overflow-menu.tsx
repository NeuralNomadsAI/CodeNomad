import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { For, Show, createMemo, createSignal, onCleanup, type JSXElement } from "solid-js"
import { MoreHorizontal } from "lucide-solid"
import { suppressCompatibilityClick } from "../lib/compatibility-click"

export interface ActionOverflowMenuItem {
  key: string
  label: string
  description?: string
  icon?: JSXElement
  disabled?: boolean
  checked?: boolean
  /** Use for actions that need the current user gesture rather than menu focus restoration. */
  selectBeforeClose?: boolean
  /** Focus target of a window opened in the selection gesture. */
  focusAfterSelect?: () => HTMLElement | undefined
  onSelect: () => void | Promise<void>
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

interface ActionOverflowMenuProps {
  items: ActionOverflowMenuItem[]
  label: string
  triggerClass?: string
  minItems?: number
  onOpenChange?: (open: boolean) => void
  onFocusRestored?: () => void
}

export default function ActionOverflowMenu(props: ActionOverflowMenuProps) {
  let selectedAction: ActionOverflowMenuItem["onSelect"] | undefined
  let gestureFocus: ActionOverflowMenuItem["focusAfterSelect"]
  let trigger: HTMLButtonElement | undefined
  let pointerType: string | undefined
  const [hoveredItem, setHoveredItem] = createSignal<ActionOverflowMenuItem | null>(null)
  const itemsByKey = createMemo(() => new Map(props.items.map(item => [item.key, item])))
  const enabledItems = () => props.items.filter((item) => !item.disabled)
  const hasItems = () => props.items.length >= (props.minItems ?? 1)
  const clearHoveredItem = () => {
    const item = hoveredItem()
    if (!item) return
    item.onMouseLeave?.()
    setHoveredItem(null)
  }

  onCleanup(clearHoveredItem)

  return (
    <Show when={hasItems()}>
      <DropdownMenu placement="bottom-end" gutter={4} onOpenChange={(open) => {
        if (!open) clearHoveredItem()
        props.onOpenChange?.(open)
      }}>
        <DropdownMenu.Trigger
          ref={element => { trigger = element }}
          class={`action-overflow-trigger ${props.triggerClass ?? ""}`.trim()}
          aria-label={props.label}
          title={props.label}
          disabled={enabledItems().length === 0}
        >
          <MoreHorizontal class="w-3.5 h-3.5" aria-hidden="true" />
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content class="action-overflow-content" onCloseAutoFocus={event => {
            const active = document.activeElement
            const button = trigger
            const target = gestureFocus?.()
            gestureFocus = undefined
            if (target?.isConnected && button && !button.inert) {
              // Kobalte focuses the trigger even when the autofocus event is prevented.
              button.inert = true
              queueMicrotask(() => { button.inert = false })
              if (!active || active === document.body || active === button || (event.currentTarget as Element)?.contains(active)) {
                target.focus({ preventScroll: true })
              }
            }
            // Kobalte restores the trigger after this callback. Launch selected
            // actions afterwards so a newly opened window keeps its autofocus.
            const action = selectedAction
            selectedAction = undefined
            if (action || props.onFocusRestored) queueMicrotask(() => {
              void action?.()
              props.onFocusRestored?.()
            })
          }}>
            <For each={[...itemsByKey().keys()]}>
              {(key) => {
                const item = () => itemsByKey().get(key)
                onCleanup(() => { if (hoveredItem()?.key === key) clearHoveredItem() })
                return (
                  <DropdownMenu.Item
                    class="action-overflow-item"
                    data-action-key={key}
                    role={typeof item()?.checked === "boolean" ? "menuitemcheckbox" : undefined}
                    aria-checked={item()?.checked}
                    disabled={item()?.disabled}
                    textValue={item()?.label}
                    aria-description={item()?.description}
                    title={item()?.description}
                    onPointerEnter={() => {
                      const entry = item()
                      if (!entry || entry.disabled) return
                      clearHoveredItem()
                      setHoveredItem(entry)
                      entry.onMouseEnter?.()
                    }}
                    onPointerLeave={() => {
                      if (hoveredItem()?.key === key) clearHoveredItem()
                    }}
                    // Kobalte selects on pointerup; record it for the selection below.
                    onPointerUp={(event) => { pointerType = event.pointerType }}
                    onKeyDown={() => { pointerType = undefined }}
                    onSelect={() => {
                      const entry = item()
                      clearHoveredItem()
                      if (pointerType && pointerType !== "mouse") suppressCompatibilityClick()
                      pointerType = undefined
                      if (!entry || entry.disabled) return
                      if (entry.selectBeforeClose) {
                        gestureFocus = entry.focusAfterSelect
                        void entry.onSelect()
                      }
                      else selectedAction = entry.onSelect
                    }}
                  >
                    <Show when={item()?.icon} fallback={<span class="action-overflow-item-icon" aria-hidden="true" />}>
                      {(icon) => <span class="action-overflow-item-icon" aria-hidden="true">{icon()}</span>}
                    </Show>
                    <span class="action-overflow-item-label">{item()?.label}</span>
                  </DropdownMenu.Item>
                )
              }}
            </For>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}
