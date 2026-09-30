import type { Component } from "solid-js"
import { For, onMount } from "solid-js"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "../../../action-overflow-menu"
import { observeRowOverflow } from "./row-compact-actions"

// File row actions with the message/session convention: inline icon buttons
// while they fit, the shared overflow menu only when they don't. Hidden
// actions stay measurable but inert; an open menu stays mounted.
const FileRowActions: Component<{ items: ActionOverflowMenuItem[]; label: string }> = props => {
  let element!: HTMLSpanElement
  onMount(() => observeRowOverflow(element))
  // Preview toggles remain directly reachable; only secondary actions overflow.
  const toggles = () => props.items.filter(item => typeof item.checked === "boolean")
  const secondary = () => props.items.filter(item => typeof item.checked !== "boolean")
  const button = (item: ActionOverflowMenuItem) => <button type="button" class="file-row-icon-button"
    classList={{ "icon-toggle": typeof item.checked === "boolean" }} title={item.label} aria-label={item.label} aria-pressed={item.checked}
    disabled={item.disabled} onClick={() => void item.onSelect()}>{item.icon}</button>
  return <span class="file-row-actions" data-compact="false" ref={element}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <span class="file-row-pinned-actions"><For each={toggles()}>{button}</For></span>
    <span class="file-row-inline-actions">
      <For each={secondary()}>{button}</For>
    </span>
    <ActionOverflowMenu items={secondary()} label={props.label} triggerClass="file-row-icon-button action-overflow-trigger" />
  </span>
}

export default FileRowActions
