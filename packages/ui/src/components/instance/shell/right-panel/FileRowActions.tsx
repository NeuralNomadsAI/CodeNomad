import type { Component } from "solid-js"
import { For } from "solid-js"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "../../../action-overflow-menu"
import { observeRowOverflow } from "./row-compact-actions"

// File row actions with the message/session convention: inline icon buttons
// while they fit, the shared overflow menu only when they don't. Hidden
// actions stay measurable but inert; an open menu stays mounted.
const FileRowActions: Component<{ items: ActionOverflowMenuItem[]; label: string }> = props => {
  return <span class="file-row-actions" data-compact="false" ref={element => observeRowOverflow(element)}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <span class="file-row-inline-actions">
      <For each={props.items}>{item => (
        <button type="button" class="file-row-icon-button" title={item.label} aria-label={item.label}
          disabled={item.disabled} onClick={() => void item.onSelect()}>
          {item.icon}
        </button>
      )}</For>
    </span>
    <ActionOverflowMenu items={props.items} label={props.label} triggerClass="file-row-icon-button action-overflow-trigger" />
  </span>
}

export default FileRowActions
