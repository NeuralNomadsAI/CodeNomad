import { Component, Show, For, createSignal, createMemo, createEffect, onMount } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, Plus, Trash2, Edit2, Check, ChevronDown, ChevronRight, Zap, Save, AlertCircle } from "lucide-solid"
import { Button, Badge, Input } from "./ui"
import type { Command as SDKCommand } from "@opencode-ai/sdk"
import { getCommands, fetchCommands } from "../stores/commands"
import { instances } from "../stores/instances"
import { getLogger } from "../lib/logger"

const log = getLogger("commands-settings")

interface CustomCommand {
  name: string
  template: string
  description?: string
  agent?: string
  model?: string
  subtask?: boolean
}

interface CommandsSettingsPanelProps {
  open: boolean
  onClose: () => void
  instanceId: string | null
}

const BUILT_IN_COMMANDS = ["init", "undo", "redo", "share", "help", "compact", "cost", "bug", "config", "doctor", "model", "context"]

const CommandsSettingsPanel: Component<CommandsSettingsPanelProps> = (props) => {
  const [showBuiltIn, setShowBuiltIn] = createSignal(true)
  const [showCustom, setShowCustom] = createSignal(true)
  const [isAddingCommand, setIsAddingCommand] = createSignal(false)
  const [editingCommand, setEditingCommand] = createSignal<string | null>(null)
  const [saveError, setSaveError] = createSignal<string | null>(null)
  const [saveSuccess, setSaveSuccess] = createSignal(false)

  // Form state for new/editing command
  const [formName, setFormName] = createSignal("")
  const [formTemplate, setFormTemplate] = createSignal("")
  const [formDescription, setFormDescription] = createSignal("")
  const [formAgent, setFormAgent] = createSignal("")
  const [formModel, setFormModel] = createSignal("")
  const [formSubtask, setFormSubtask] = createSignal(false)

  const allCommands = createMemo(() => {
    if (!props.instanceId) return []
    return getCommands(props.instanceId)
  })

  const builtInCommands = createMemo(() => {
    return allCommands().filter((cmd) => BUILT_IN_COMMANDS.includes(cmd.name))
  })

  const customCommands = createMemo(() => {
    return allCommands().filter((cmd) => !BUILT_IN_COMMANDS.includes(cmd.name))
  })

  const getInstance = () => {
    if (!props.instanceId) return null
    return instances().get(props.instanceId)
  }

  const resetForm = () => {
    setFormName("")
    setFormTemplate("")
    setFormDescription("")
    setFormAgent("")
    setFormModel("")
    setFormSubtask(false)
  }

  const startAddCommand = () => {
    resetForm()
    setEditingCommand(null)
    setIsAddingCommand(true)
    setSaveError(null)
  }

  const startEditCommand = (cmd: SDKCommand) => {
    setFormName(cmd.name)
    setFormTemplate(cmd.template)
    setFormDescription(cmd.description || "")
    setFormAgent(cmd.agent || "")
    setFormModel(cmd.model || "")
    setFormSubtask(cmd.subtask || false)
    setIsAddingCommand(false)
    setEditingCommand(cmd.name)
    setSaveError(null)
  }

  const cancelEdit = () => {
    resetForm()
    setIsAddingCommand(false)
    setEditingCommand(null)
    setSaveError(null)
  }

  const saveCommand = async () => {
    const instance = getInstance()
    if (!instance?.client) {
      setSaveError("No active instance")
      return
    }

    const name = formName().trim()
    const template = formTemplate().trim()

    if (!name) {
      setSaveError("Command name is required")
      return
    }

    if (!template) {
      setSaveError("Template is required")
      return
    }

    if (!/^[a-zA-Z][a-zA-Z0-9-_]*$/.test(name)) {
      setSaveError("Command name must start with a letter and contain only letters, numbers, hyphens, and underscores")
      return
    }

    try {
      // Build the command config
      const newCommand: Record<string, unknown> = {
        template,
      }

      if (formDescription().trim()) {
        newCommand.description = formDescription().trim()
      }
      if (formAgent().trim()) {
        newCommand.agent = formAgent().trim()
      }
      if (formModel().trim()) {
        newCommand.model = formModel().trim()
      }
      if (formSubtask()) {
        newCommand.subtask = true
      }

      // Get current config and update it
      const configResponse = await instance.client.config.get({})
      const currentConfig = configResponse.data || {}

      const updatedConfig = {
        ...currentConfig,
        command: {
          ...(currentConfig.command || {}),
          [name]: newCommand,
        },
      }

      // Save the updated config
      await instance.client.config.update({
        body: updatedConfig,
      })

      // Refresh commands list
      await fetchCommands(props.instanceId!, instance.client)

      // Show success and reset
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
      cancelEdit()

      log.info("Command saved successfully", { name })
    } catch (error) {
      log.error("Failed to save command", error)
      setSaveError(error instanceof Error ? error.message : "Failed to save command")
    }
  }

  const deleteCommand = async (commandName: string) => {
    const instance = getInstance()
    if (!instance?.client) return

    try {
      // Get current config
      const configResponse = await instance.client.config.get({})
      const currentConfig = configResponse.data || {}

      if (!currentConfig.command?.[commandName]) {
        setSaveError("Command not found in config")
        return
      }

      // Remove the command
      const { [commandName]: _, ...remainingCommands } = currentConfig.command

      const updatedConfig = {
        ...currentConfig,
        command: remainingCommands,
      }

      // Save the updated config
      await instance.client.config.update({
        body: updatedConfig,
      })

      // Refresh commands list
      await fetchCommands(props.instanceId!, instance.client)

      log.info("Command deleted successfully", { commandName })
    } catch (error) {
      log.error("Failed to delete command", error)
      setSaveError(error instanceof Error ? error.message : "Failed to delete command")
    }
  }

  const isEditing = () => isAddingCommand() || editingCommand() !== null

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-40 bg-black/50" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="flex flex-col w-full max-w-2xl rounded-lg bg-background border border-border shadow-xl max-h-[85vh]">
            <div class="flex items-center justify-between px-5 py-4 border-b border-border">
              <Dialog.Title class="flex items-center gap-2 text-lg font-semibold text-foreground">
                <Zap class="w-5 h-5" />
                Slash Commands
              </Dialog.Title>
              <Dialog.CloseButton class="p-1.5 rounded transition-colors text-muted-foreground hover:bg-accent hover:text-foreground">
                <X class="w-4 h-4" />
              </Dialog.CloseButton>
            </div>

            <div class="flex-1 overflow-y-auto p-5">
              {/* Success/Error Messages */}
              <Show when={saveSuccess()}>
                <div class="flex items-center gap-2 px-3 py-2 rounded-md text-sm mb-4 bg-success/10 text-success border border-success/20">
                  <Check class="w-4 h-4" />
                  Command saved successfully
                </div>
              </Show>

              <Show when={saveError()}>
                <div class="flex items-center gap-2 px-3 py-2 rounded-md text-sm mb-4 bg-destructive/10 text-destructive border border-destructive/20">
                  <AlertCircle class="w-4 h-4" />
                  {saveError()}
                </div>
              </Show>

              {/* Add/Edit Form */}
              <Show when={isEditing()}>
                <div class="p-4 rounded-lg mb-4 bg-secondary border border-border">
                  <h3 class="text-sm font-medium mb-4 text-foreground">
                    {isAddingCommand() ? "Add Custom Command" : `Edit /${editingCommand()}`}
                  </h3>

                  <div class="mb-4">
                    <label class="block text-xs font-medium mb-1.5 text-muted-foreground">Command Name</label>
                    <Input
                      type="text"
                      placeholder="e.g., test, deploy, review"
                      value={formName()}
                      onInput={(e) => setFormName(e.currentTarget.value)}
                      disabled={editingCommand() !== null}
                    />
                    <span class="block text-xs mt-1 text-muted-foreground">Used as /{formName() || "command"}</span>
                  </div>

                  <div class="mb-4">
                    <label class="block text-xs font-medium mb-1.5 text-muted-foreground">Template *</label>
                    <textarea
                      class="w-full px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground outline-none transition-colors resize-y font-mono min-h-[80px] focus:border-primary placeholder:text-muted-foreground"
                      placeholder="The prompt sent to the LLM. Use $ARGUMENTS for user input, $1, $2 for positional args."
                      value={formTemplate()}
                      onInput={(e) => setFormTemplate(e.currentTarget.value)}
                      rows={4}
                    />
                    <span class="block text-xs mt-1 text-muted-foreground">
                      Supports: $ARGUMENTS, $1 $2 etc., `!command` for shell output, @filename for file content
                    </span>
                  </div>

                  <div class="mb-4">
                    <label class="block text-xs font-medium mb-1.5 text-muted-foreground">Description</label>
                    <Input
                      type="text"
                      placeholder="Brief explanation shown in the picker"
                      value={formDescription()}
                      onInput={(e) => setFormDescription(e.currentTarget.value)}
                    />
                  </div>

                  <div class="flex gap-4 mb-4">
                    <div class="mb-4 flex-1">
                      <label class="block text-xs font-medium mb-1.5 text-muted-foreground">Agent</label>
                      <Input
                        type="text"
                        placeholder="e.g., build, code"
                        value={formAgent()}
                        onInput={(e) => setFormAgent(e.currentTarget.value)}
                      />
                    </div>

                    <div class="mb-4 flex-1">
                      <label class="block text-xs font-medium mb-1.5 text-muted-foreground">Model</label>
                      <Input
                        type="text"
                        placeholder="e.g., anthropic/claude-sonnet"
                        value={formModel()}
                        onInput={(e) => setFormModel(e.currentTarget.value)}
                      />
                    </div>
                  </div>

                  <div class="flex items-center gap-2 mb-4">
                    <input
                      type="checkbox"
                      id="subtask-checkbox"
                      class="w-4 h-4 rounded accent-primary"
                      checked={formSubtask()}
                      onChange={(e) => setFormSubtask(e.currentTarget.checked)}
                    />
                    <label for="subtask-checkbox" class="text-sm text-muted-foreground">Run as subtask (spawns subagent)</label>
                  </div>

                  <div class="flex items-center justify-end gap-2 pt-4 mt-4 border-t border-border">
                    <Button variant="outline" onClick={cancelEdit}>
                      Cancel
                    </Button>
                    <Button onClick={saveCommand}>
                      <Save class="w-4 h-4" />
                      Save Command
                    </Button>
                  </div>
                </div>
              </Show>

              {/* Commands List */}
              <Show when={!isEditing()}>
                {/* Add Command Button */}
                <button
                  class="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-md text-sm font-medium transition-colors mb-4 bg-primary text-primary-foreground hover:brightness-110"
                  onClick={startAddCommand}
                >
                  <Plus class="w-4 h-4" />
                  Add Custom Command
                </button>

                {/* Custom Commands Section */}
                <div class="mb-4">
                  <button
                    class="flex items-center gap-2 w-full text-left text-sm font-medium py-2 px-2 -mx-2 rounded transition-colors text-foreground hover:bg-accent"
                    onClick={() => setShowCustom(!showCustom())}
                  >
                    {showCustom() ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
                    <span>Custom Commands</span>
                    <span class="ml-auto text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{customCommands().length}</span>
                  </button>

                  <Show when={showCustom()}>
                    <div class="mt-2 space-y-2">
                      <Show when={customCommands().length === 0}>
                        <div class="text-sm text-center py-6 px-4 rounded-lg bg-secondary text-muted-foreground">
                          No custom commands defined. Click "Add Custom Command" to create one.
                        </div>
                      </Show>
                      <For each={customCommands()}>
                        {(cmd) => (
                          <div class="flex items-start justify-between gap-3 p-3 rounded-lg transition-colors bg-secondary hover:bg-accent">
                            <div class="flex-1 min-w-0">
                              <div class="text-sm font-mono font-medium text-info">/{cmd.name}</div>
                              <Show when={cmd.description}>
                                <div class="text-xs mt-0.5 truncate text-muted-foreground">{cmd.description}</div>
                              </Show>
                              <div class="flex flex-wrap gap-1.5 mt-1.5">
                                <Show when={cmd.agent}>
                                  <Badge variant="secondary" class="text-xs">agent: {cmd.agent}</Badge>
                                </Show>
                                <Show when={cmd.model}>
                                  <Badge variant="secondary" class="text-xs">model: {cmd.model}</Badge>
                                </Show>
                                <Show when={cmd.subtask}>
                                  <Badge variant="secondary" class="text-xs">subtask</Badge>
                                </Show>
                              </div>
                            </div>
                            <div class="flex items-center gap-1">
                              <button
                                class="p-1.5 rounded transition-colors text-muted-foreground hover:bg-background hover:text-foreground"
                                onClick={() => startEditCommand(cmd)}
                                title="Edit command"
                              >
                                <Edit2 class="w-4 h-4" />
                              </button>
                              <button
                                class="p-1.5 rounded transition-colors text-muted-foreground hover:bg-background hover:text-destructive"
                                onClick={() => deleteCommand(cmd.name)}
                                title="Delete command"
                              >
                                <Trash2 class="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                {/* Built-in Commands Section */}
                <div class="mb-4">
                  <button
                    class="flex items-center gap-2 w-full text-left text-sm font-medium py-2 px-2 -mx-2 rounded transition-colors text-foreground hover:bg-accent"
                    onClick={() => setShowBuiltIn(!showBuiltIn())}
                  >
                    {showBuiltIn() ? <ChevronDown class="w-4 h-4" /> : <ChevronRight class="w-4 h-4" />}
                    <span>Built-in Commands</span>
                    <span class="ml-auto text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{builtInCommands().length}</span>
                  </button>

                  <Show when={showBuiltIn()}>
                    <div class="mt-2 space-y-2">
                      <For each={builtInCommands()}>
                        {(cmd) => (
                          <div class="flex items-start justify-between gap-3 p-3 rounded-lg transition-colors bg-secondary opacity-70">
                            <div class="flex-1 min-w-0">
                              <div class="text-sm font-mono font-medium text-info">/{cmd.name}</div>
                              <Show when={cmd.description}>
                                <div class="text-xs mt-0.5 truncate text-muted-foreground">{cmd.description}</div>
                              </Show>
                            </div>
                            <Badge variant="secondary" class="text-xs self-start">built-in</Badge>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                {/* Documentation Link */}
                <div class="mt-4 pt-4 text-center border-t border-border">
                  <a
                    href="https://opencode.ai/docs/commands/"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-sm underline text-info hover:opacity-80"
                  >
                    Learn more about slash commands
                  </a>
                </div>
              </Show>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default CommandsSettingsPanel
