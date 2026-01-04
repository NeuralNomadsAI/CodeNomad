import { Component } from "solid-js"
import type { Command as SDKCommand } from "@opencode-ai/sdk"
import { highlightMatch } from "../lib/command-filter"

/**
 * Individual command suggestion item within the floating suggestions list
 * Displays command name, description, and usage with match highlighting
 */

interface CommandSuggestionItemProps {
  command: SDKCommand
  isSelected: boolean
  onClick: (command: SDKCommand) => void
  onHover?: (command: SDKCommand) => void
  searchQuery?: string
}

/**
 * CommandSuggestionItem Component
 * 
 * Renders a single command item with:
 * - Command name (highlighted if matches query)
 * - Description (gray text)
 * - Usage/template (mono font, smaller)
 * - Selection state (background + left border)
 * - Hover state
 * 
 * @example
 * <CommandSuggestionItem
 *   command={{ name: "analyze", description: "Analyze code", ... }}
 *   isSelected={true}
 *   onClick={(cmd) => console.log(cmd)}
 *   searchQuery="ana"
 * />
 */
const CommandSuggestionItem: Component<CommandSuggestionItemProps> = (props) => {
  const handleClick = () => {
    props.onClick(props.command)
  }

  const handleMouseEnter = () => {
    props.onHover?.(props.command)
  }

  // Highlight matching text in command name
  const highlightedNameSegments = () => {
    if (!props.searchQuery) {
      return [{ text: props.command.name, isMatch: false }]
    }
    return highlightMatch(props.command.name, props.searchQuery)
  }

  return (
    <div
      class={`command-suggestion-item ${props.isSelected ? "command-suggestion-item--selected" : ""}`}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      role="option"
      aria-selected={props.isSelected}
      tabindex={-1}
    >
      {/* Command name with highlight */}
      <div class="command-suggestion-item-name">
        {highlightedNameSegments().map((segment) => (
          <span class={segment.isMatch ? "highlight" : ""}>{segment.text}</span>
        ))}
      </div>

      {/* Description (if available) */}
      {props.command.description && (
        <div class="command-suggestion-item-description">{props.command.description}</div>
      )}

      {/* Usage/template (if available) */}
      {props.command.template && (
        <div class="command-suggestion-item-usage">{props.command.template}</div>
      )}
    </div>
  )
}

export default CommandSuggestionItem
