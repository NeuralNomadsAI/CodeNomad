import { Component, createSignal, For, Show, createEffect, createMemo } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import type { Command } from "../lib/commands"
import { cn } from "../lib/cn"
import Kbd from "./kbd"

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  commands: Command[]
  onExecute: (command: Command) => void
}

function buildShortcutString(shortcut: Command["shortcut"]): string {
  if (!shortcut) return ""

  const parts: string[] = []

  if (shortcut.meta || shortcut.ctrl) parts.push("cmd")
  if (shortcut.shift) parts.push("shift")
  if (shortcut.alt) parts.push("alt")
  parts.push(shortcut.key)

  return parts.join("+")
}

const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const [query, setQuery] = createSignal("")
  const [selectedCommandId, setSelectedCommandId] = createSignal<string | null>(null)
  const [isPointerSelecting, setIsPointerSelecting] = createSignal(false)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  const categoryOrder = ["Custom Commands", "Instance", "Session", "Agent & Model", "Input & Focus", "System", "Other"] as const

  type CommandGroup = { category: string; commands: Command[]; startIndex: number }
  type ProcessedCommands = { groups: CommandGroup[]; ordered: Command[] }

  const processedCommands = createMemo<ProcessedCommands>(() => {
    const source = props.commands ?? []
    const q = query().trim().toLowerCase()

    const filtered = q
      ? source.filter((cmd) => {
          const label = typeof cmd.label === "function" ? cmd.label() : cmd.label
          const labelMatch = label.toLowerCase().includes(q)
          const descMatch = cmd.description.toLowerCase().includes(q)
          const keywordMatch = cmd.keywords?.some((k) => k.toLowerCase().includes(q))
          const categoryMatch = cmd.category?.toLowerCase().includes(q)
          return labelMatch || descMatch || keywordMatch || categoryMatch
        })
      : source

    const groupsMap = new Map<string, Command[]>()
    for (const cmd of filtered) {
      const category = cmd.category || "Other"
      const list = groupsMap.get(category)
      if (list) {
        list.push(cmd)
      } else {
        groupsMap.set(category, [cmd])
      }
    }

    const groups: CommandGroup[] = []
    const ordered: Command[] = []
    const processedCategories = new Set<string>()

    const addGroup = (category: string) => {
      const cmds = groupsMap.get(category)
      if (!cmds || cmds.length === 0 || processedCategories.has(category)) return
      groups.push({ category, commands: cmds, startIndex: ordered.length })
      ordered.push(...cmds)
      processedCategories.add(category)
    }

    for (const category of categoryOrder) {
      addGroup(category)
    }

    for (const [category] of groupsMap) {
      addGroup(category)
    }

    return { groups, ordered }
  })

  const groupedCommandList = () => processedCommands().groups
  const orderedCommands = () => processedCommands().ordered
  const selectedIndex = createMemo(() => {
    const ordered = orderedCommands()
    if (ordered.length === 0) return -1
    const id = selectedCommandId()
    if (!id) return 0
    const index = ordered.findIndex((cmd) => cmd.id === id)
    return index >= 0 ? index : 0
  })

  createEffect(() => {
    if (props.open) {
      setQuery("")
      setSelectedCommandId(null)
      setIsPointerSelecting(false)
      setTimeout(() => inputRef?.focus(), 100)
    }
  })

  createEffect(() => {
    const ordered = orderedCommands()
    if (ordered.length === 0) {
      if (selectedCommandId() !== null) {
        setSelectedCommandId(null)
      }
      return
    }

    const currentId = selectedCommandId()
    if (!currentId || !ordered.some((cmd) => cmd.id === currentId)) {
      setSelectedCommandId(ordered[0].id)
    }
  })


  createEffect(() => {
    const index = selectedIndex()
    if (!listRef || index < 0) return

    const selectedButton = listRef.querySelector(`[data-command-index="${index}"]`) as HTMLElement
    if (selectedButton) {
      selectedButton.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }
  })

  function handleKeyDown(e: KeyboardEvent) {
    const ordered = orderedCommands()

    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      props.onClose()
      return
    }

    if (ordered.length === 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }

    if (e.key === "ArrowDown") {
      e.preventDefault()
      e.stopPropagation()
      setIsPointerSelecting(false)
      const current = selectedIndex()
      const nextIndex = Math.min((current < 0 ? 0 : current) + 1, ordered.length - 1)
      setSelectedCommandId(ordered[nextIndex]?.id ?? null)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      e.stopPropagation()
      setIsPointerSelecting(false)
      const current = selectedIndex()
      const nextIndex = current <= 0 ? ordered.length - 1 : current - 1
      setSelectedCommandId(ordered[nextIndex]?.id ?? null)
    } else if (e.key === "Enter") {
      e.preventDefault()
      e.stopPropagation()
      const index = selectedIndex()
      if (index < 0 || index >= ordered.length) return
      const command = ordered[index]
      if (!command) return
      props.onExecute(command)
      props.onClose()
    }
  }

  function handleCommandClick(command: Command) {
    props.onExecute(command)
    props.onClose()
  }

  function handlePointerLeave() {
    setIsPointerSelecting(false)
  }

  return (

    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <div class="fixed inset-0 z-50 flex items-end md:items-start justify-center md:pt-[20vh]">
          <Dialog.Content
            class="rounded-t-xl md:rounded-xl shadow-2xl flex flex-col bg-background text-foreground w-full max-w-2xl max-h-[80vh] md:max-h-[60vh] overflow-hidden"
            style={{ "max-width": "min(100%, calc(100vw - 0px))", "overflow-wrap": "anywhere", "word-break": "break-word", "padding-bottom": "env(safe-area-inset-bottom, 0px)" }}
            onKeyDown={handleKeyDown}
          >
            <Dialog.Title class="sr-only">Command Palette</Dialog.Title>
            <Dialog.Description class="sr-only">Search and execute commands</Dialog.Description>

            <div class="p-4 border-b border-border">
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                <input
                  ref={inputRef}
                  type="text"
                  value={query()}
                  onInput={(e) => {
                    setQuery(e.currentTarget.value)
                    setSelectedCommandId(null)
                  }}
                  placeholder="Type a command or search..."
                  class="flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground text-base"
                />
              </div>
            </div>

            <div
              ref={listRef}
              class="flex-1 overflow-y-auto"
              data-pointer-mode={isPointerSelecting() ? "pointer" : "keyboard"}
              onPointerLeave={handlePointerLeave}
            >
              <Show
                when={orderedCommands().length > 0}
                fallback={<div class="p-8 text-center text-muted-foreground">No commands found for "{query()}"</div>}
              >
                <For each={groupedCommandList()}>
                  {(group) => (
                    <div class="py-2">
                      <div class="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.category}
                      </div>
                      <For each={group.commands}>
                        {(command, localIndex) => {
                          const commandIndex = group.startIndex + localIndex()
                          return (
                            <button
                              type="button"
                              data-command-index={commandIndex}
                              onClick={() => handleCommandClick(command)}
                              class={cn(
                                "w-full px-4 py-3 min-h-[48px] flex items-start gap-3 transition-colors cursor-pointer border-none text-left text-foreground",
                                selectedCommandId() === command.id && "bg-accent",
                                isPointerSelecting() && selectedCommandId() !== command.id && "hover:bg-accent/50",
                              )}
                              onPointerMove={(event) => {
                                if (event.movementX === 0 && event.movementY === 0) return
                                if (event.pointerType === "mouse" || event.pointerType === "pen" || event.pointerType === "touch") {
                                  if (!isPointerSelecting()) {
                                    setIsPointerSelecting(true)
                                  }
                                  setSelectedCommandId(command.id)
                                }
                              }}
                            >
                              <div class="flex-1 min-w-0">
                                <div class="font-medium text-foreground">
                                  {typeof command.label === "function" ? command.label() : command.label}
                                </div>
                                <div class="text-sm mt-0.5 text-muted-foreground">
                                  {command.description}
                                </div>
                              </div>
                              <Show when={command.shortcut}>
                                <div class="mt-1">
                                  <Kbd shortcut={buildShortcutString(command.shortcut)} />
                                </div>
                              </Show>
                            </button>
                          )
                        }}
                      </For>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default CommandPalette
