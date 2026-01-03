import { Component, createSignal, createEffect, For, Show, Accessor } from "solid-js"
import type { Command as SDKCommand } from "@opencode-ai/sdk"
import { filterCommands } from "../lib/command-filter"
import CommandSuggestionItem from "./command-suggestion-item"

/**
 * Floating suggestions card that displays filtered command suggestions
 * Positioned above the prompt input, supports keyboard navigation
 */

interface CommandSuggestionsProps {
  // List of available commands to display
  commands: Accessor<SDKCommand[]>

  // Whether suggestions panel is visible
  isOpen: Accessor<boolean>

  // Currently searched command name/keyword
  searchQuery: Accessor<string>

  // Index of currently selected item (keyboard navigation)
  selectedIndex: Accessor<number>

  // Callback when user selects a command
  onSelect: (command: SDKCommand) => void

  // Callback to close suggestions panel
  onClose: () => void

  // Callback when user types in search
  onQueryChange: (query: string) => void

  // Callback to update selected index (keyboard nav)
  onSelectedIndexChange: (index: number) => void

  // Position relative to parent (prompt input container)
  position?: { top: number; left: number }

  // Maximum items to show before scrolling (default: 8)
  maxVisibleItems?: number
}

/**
 * CommandSuggestions Component
 * 
 * Displays filtered command suggestions in a floating card above the prompt input.
 * Supports:
 * - Keyboard navigation (↑ ↓ Enter Escape)
 * - Mouse selection (click to select, hover to highlight)
 * - Click outside to close
 * - Responsive positioning
 * 
 * @example
 * <CommandSuggestions
 *   commands={() => getCommands(instanceId)}
 *   isOpen={() => commandMode()}
 *   searchQuery={() => commandQuery()}
 *   selectedIndex={() => selectedCommandIndex()}
 *   onSelect={handleSelect}
 *   onClose={() => setCommandMode(false)}
 *   onQueryChange={setCommandQuery}
 *   onSelectedIndexChange={setSelectedCommandIndex}
 * />
 */
const CommandSuggestions: Component<CommandSuggestionsProps> = (props) => {
  const maxVisible = () => props.maxVisibleItems ?? 8
  const filteredCommands = () => filterCommands(props.searchQuery(), props.commands())
  const hasResults = () => filteredCommands().length > 0

  let containerRef: HTMLDivElement | undefined
  let scrollContainerRef: HTMLDivElement | undefined

  // Auto-scroll to keep selected item in view
  createEffect(() => {
    if (!scrollContainerRef) return

    const selectedIdx = props.selectedIndex()
    const itemHeight = 45 // Approximate height of each item (check CSS)
    const scrollTop = scrollContainerRef.scrollTop
    const scrollHeight = scrollContainerRef.clientHeight

    const itemTop = selectedIdx * itemHeight
    const itemBottom = itemTop + itemHeight

    // Scroll up if selected item is above visible area
    if (itemTop < scrollTop) {
      scrollContainerRef.scrollTop = itemTop
    }
    // Scroll down if selected item is below visible area
    else if (itemBottom > scrollTop + scrollHeight) {
      scrollContainerRef.scrollTop = itemBottom - scrollHeight
    }
  })

  // Close suggestions if clicked outside
  createEffect(() => {
    if (!props.isOpen()) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (containerRef && !containerRef.contains(target)) {
        props.onClose()
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  })

  // Handle keyboard navigation (up/down through items)
  // Note: This component only manages selection visually
  // The parent (PromptInput) handles actual keyboard events and calls onSelectedIndexChange
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!props.isOpen()) return

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        const nextIdx = Math.min(props.selectedIndex() + 1, filteredCommands().length - 1)
        props.onSelectedIndexChange(nextIdx)
        break

      case "ArrowUp":
        e.preventDefault()
        const prevIdx = Math.max(props.selectedIndex() - 1, 0)
        props.onSelectedIndexChange(prevIdx)
        break

      case "Enter":
        e.preventDefault()
        const selected = filteredCommands()[props.selectedIndex()]
        if (selected) {
          props.onSelect(selected)
        }
        break

      case "Escape":
        e.preventDefault()
        props.onClose()
        break
    }
  }

  // Reset selected index when filtered results change
  createEffect(() => {
    filteredCommands() // Dependency
    props.onSelectedIndexChange(0)
  })

  const position = () => props.position ?? { top: -340, left: 0 }
  const posStyle = () => `
    position: absolute;
    top: ${position().top}px;
    left: ${position().left}px;
    width: 100%;
  `

  return (
    <Show when={props.isOpen()}>
      <div
        ref={containerRef}
        class="command-suggestions"
        style={posStyle()}
        onKeyDown={handleKeyDown}
      >
        {/* Empty state */}
        <Show when={!hasResults()}>
          <div class="command-suggestions-empty">
            <div class="command-suggestions-empty-text">
              No commands found for "{props.searchQuery()}"
            </div>
          </div>
        </Show>

        {/* Suggestions list */}
        <Show when={hasResults()}>
          <div
            ref={scrollContainerRef}
            class="command-suggestions-list"
            role="listbox"
            style={{
              "max-height": `${maxVisible() * 45 + 16}px`, // items + padding
            }}
          >
            <For each={filteredCommands()}>
              {(command, idx) => (
                <CommandSuggestionItem
                  command={command}
                  isSelected={idx() === props.selectedIndex()}
                  onClick={props.onSelect}
                  searchQuery={props.searchQuery()}
                />
              )}
            </For>
          </div>
        </Show>

        {/* Results counter */}
        <Show when={hasResults()}>
          <div class="command-suggestions-footer">
            <span class="command-suggestions-count">
              {filteredCommands().length} command{filteredCommands().length !== 1 ? "s" : ""}
            </span>
          </div>
        </Show>
      </div>
    </Show>
  )
}

export default CommandSuggestions
