import { Component, createSignal, createEffect, For, Show, onCleanup, createMemo } from "solid-js"
import type { Command as SDKCommand } from "@opencode-ai/sdk"
import { getCommands } from "../stores/commands"
import { cn } from "../lib/cn"

interface SlashCommandPickerProps {
  open: boolean
  onSelect: (command: SDKCommand, args: string) => void
  onClose: () => void
  searchQuery: string
  instanceId: string
  textareaRef?: HTMLTextAreaElement
}

const SlashCommandPicker: Component<SlashCommandPickerProps> = (props) => {
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  let containerRef: HTMLDivElement | undefined
  let scrollContainerRef: HTMLDivElement | undefined

  const allCommands = createMemo(() => getCommands(props.instanceId))

  const filteredCommands = createMemo(() => {
    const commands = allCommands()
    const query = props.searchQuery.toLowerCase()

    if (!query) return commands

    return commands.filter((cmd) => {
      const nameMatch = cmd.name.toLowerCase().includes(query)
      const descMatch = cmd.description?.toLowerCase().includes(query)
      return nameMatch || descMatch
    })
  })

  createEffect(() => {
    if (!props.open) return
    setSelectedIndex(0)
  })

  createEffect(() => {
    // Reset selection when filter changes
    const _ = filteredCommands()
    setSelectedIndex(0)
  })

  function scrollToSelected() {
    setTimeout(() => {
      const selectedElement = containerRef?.querySelector('[data-picker-selected="true"]')
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: "nearest", behavior: "smooth" })
      }
    }, 0)
  }

  function handleSelect(command: SDKCommand) {
    props.onSelect(command, "")
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!props.open) return

    const commands = filteredCommands()

    if (e.key === "ArrowDown") {
      e.preventDefault()
      e.stopPropagation()
      setSelectedIndex((prev) => Math.min(prev + 1, commands.length - 1))
      scrollToSelected()
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      e.stopPropagation()
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
      scrollToSelected()
    } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
      const selected = commands[selectedIndex()]
      if (selected) {
        handleSelect(selected)
      }
    } else if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      props.onClose()
    } else if (e.key === "Tab") {
      e.preventDefault()
      e.stopPropagation()
      const selected = commands[selectedIndex()]
      if (selected) {
        handleSelect(selected)
      }
    }
  }

  createEffect(() => {
    if (props.open) {
      document.addEventListener("keydown", handleKeyDown, true)
      onCleanup(() => {
        document.removeEventListener("keydown", handleKeyDown, true)
      })
    }
  })

  const commandCount = () => filteredCommands().length

  return (
    <Show when={props.open}>
      <div
        ref={containerRef}
        class="absolute w-full rounded-md shadow-lg z-50 bg-background border border-border bottom-full left-0 mb-1 max-w-md"
        data-testid="slash-command-picker"
      >
        <div class="px-3 py-2 border-b border-border bg-secondary">
          <div class="text-xs font-medium text-muted-foreground">Slash Commands</div>
        </div>

        <div ref={scrollContainerRef} class="overflow-y-auto max-h-60">
          <Show when={commandCount() === 0}>
            <div class="px-3 py-4 text-center text-sm text-muted-foreground">No commands found</div>
          </Show>

          <For each={filteredCommands()}>
            {(command, index) => (
              <div
                class={cn(
                  "cursor-pointer px-3 py-2 transition-colors text-foreground",
                  index() === selectedIndex() ? "bg-accent" : "hover:bg-accent"
                )}
                data-picker-selected={index() === selectedIndex()}
                data-testid={`slash-command-${command.name}`}
                onClick={() => handleSelect(command)}
              >
                <div class="flex items-start gap-2">
                  <svg
                    class="h-4 w-4 mt-0.5 text-info"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                  </svg>
                  <div class="flex-1">
                    <div class="flex items-center gap-2">
                      <span class="text-sm font-medium">/{command.name}</span>
                    </div>
                    <Show when={command.description}>
                      <div class="mt-0.5 text-xs text-muted-foreground">
                        {command.description && command.description.length > 100
                          ? command.description.slice(0, 100) + "..."
                          : command.description}
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>

        <div class="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <div>
            <span class="font-medium">Tab</span> or <span class="font-medium">Enter</span> select &middot;{" "}
            <span class="font-medium">Esc</span> close
          </div>
        </div>
      </div>
    </Show>
  )
}

export default SlashCommandPicker
