import { Component, createSignal, For, Show, createEffect, createMemo } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { resolveResolvable, type Command } from "../lib/commands"
import Kbd from "./kbd"
import { useI18n } from "../lib/i18n"

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
  const { t } = useI18n()
  const [query, setQuery] = createSignal("")
  const [selectedCommandId, setSelectedCommandId] = createSignal<string | null>(null)
  const [isPointerSelecting, setIsPointerSelecting] = createSignal(false)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  const categoryOrder = ["Custom Commands", "Instance", "Session", "Agent & Model", "Input & Focus", "System", "Other"] as const

  const categoryLabel = (category: string) => {
    switch (category) {
      case "Custom Commands":
        return t("commandPalette.category.customCommands")
      case "Instance":
        return t("commandPalette.category.instance")
      case "Session":
        return t("commandPalette.category.session")
      case "Agent & Model":
        return t("commandPalette.category.agentModel")
      case "Input & Focus":
        return t("commandPalette.category.inputFocus")
      case "System":
        return t("commandPalette.category.system")
      case "Other":
        return t("commandPalette.category.other")
      default:
        return category
    }
  }

  type CommandGroup = { category: string; commands: Command[]; startIndex: number }
  type ProcessedCommands = { groups: CommandGroup[]; ordered: Command[] }

  const processedCommands = createMemo<ProcessedCommands>(() => {
    const source = props.commands ?? []
    const q = query().trim().toLowerCase()

    const filtered = q
      ? source.filter((cmd) => {
          const label = resolveResolvable(cmd.label)
          const description = resolveResolvable(cmd.description)
          const keywords = cmd.keywords ? resolveResolvable(cmd.keywords) : undefined
          const category = cmd.category ? resolveResolvable(cmd.category) : undefined
          const labelMatch = label.toLowerCase().includes(q)
          const descMatch = description.toLowerCase().includes(q)
          const keywordMatch = keywords?.some((k) => k.toLowerCase().includes(q))
          const categoryMatch = category?.toLowerCase().includes(q)
          return labelMatch || descMatch || keywordMatch || categoryMatch
        })
      : source

    const groupsMap = new Map<string, Command[]>()
    for (const cmd of filtered) {
      const category = (cmd.category ? resolveResolvable(cmd.category) : undefined) || "Other"
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
        <Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
            <Dialog.Content
              class="modal-surface w-full max-w-2xl max-h-[60vh]"
              onKeyDown={handleKeyDown}
            >
              <Dialog.Title class="sr-only">{t("commandPalette.title")}</Dialog.Title>
              <Dialog.Description class="sr-only">{t("commandPalette.description")}</Dialog.Description>

            <div class="modal-search-container">
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 modal-search-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                  placeholder={t("commandPalette.searchPlaceholder")}
                  class="modal-search-input"
                />
              </div>
            </div>

            <div
              ref={listRef}
              class="modal-list-container"
              data-pointer-mode={isPointerSelecting() ? "pointer" : "keyboard"}
              onPointerLeave={handlePointerLeave}
            >
              <Show
                when={orderedCommands().length > 0}
                fallback={<div class="modal-empty-state">{t("commandPalette.empty", { query: query() })}</div>}
              >
                <For each={groupedCommandList()}>
                  {(group) => (
                    <div class="py-2">
                      <div class="modal-section-header">
                        {categoryLabel(group.category)}
                      </div>
                      <For each={group.commands}>
                        {(command, localIndex) => {
                          const commandIndex = group.startIndex + localIndex()
                          return (
                            <button
                              type="button"
                              data-command-index={commandIndex}
                              onClick={() => handleCommandClick(command)}
                              class={`modal-item ${selectedCommandId() === command.id ? "modal-item-highlight" : ""}`}
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
                                <div class="modal-item-label">
                                  {resolveResolvable(command.label)}
                                </div>
                                <div class="modal-item-description">
                                  {resolveResolvable(command.description)}
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
