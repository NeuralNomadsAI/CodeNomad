import type { Command } from "./commands"
import type { Command as SDKCommand } from "@opencode-ai/sdk"
import { showAlertDialog, showPromptDialog } from "../stores/alerts"
import { activeSessionId, executeCustomCommand } from "../stores/sessions"
import { getLogger } from "./logger"
import { tGlobal } from "./i18n"

const log = getLogger("actions")

export function commandRequiresArguments(template?: string): boolean {
  if (!template) return false
  return /\$(?:\d+|ARGUMENTS)/.test(template)
}

export async function promptForCommandArguments(command: SDKCommand): Promise<string | null> {
  if (!commandRequiresArguments(command.template)) {
    return ""
  }

  try {
    return await showPromptDialog(tGlobal("commands.custom.argumentsPrompt.message", { name: command.name }), {
      title: tGlobal("commands.custom.argumentsPrompt.title"),
      variant: "info",
      inputLabel: tGlobal("commands.custom.argumentsPrompt.inputLabel"),
      inputPlaceholder: tGlobal("commands.custom.argumentsPrompt.inputPlaceholder"),
      inputDefaultValue: "",
      confirmLabel: tGlobal("commands.custom.argumentsPrompt.confirmLabel"),
      cancelLabel: tGlobal("commands.custom.argumentsPrompt.cancelLabel"),
    })
  } catch (error) {
    log.error("Failed to prompt for command arguments", error)
    showAlertDialog(tGlobal("commands.custom.argumentsPrompt.openFailed.message"), {
      title: tGlobal("commands.custom.argumentsPrompt.openFailed.title"),
      variant: "error",
    })
    return null
  }
}

function formatCommandLabel(name: string): string {
  if (!name) return ""
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function buildCustomCommandEntries(instanceId: string, commands: SDKCommand[]): Command[] {
  return commands.map((cmd) => ({
    id: `custom:${instanceId}:${cmd.name}`,
    label: formatCommandLabel(cmd.name),
    description: () => cmd.description ?? tGlobal("commands.custom.entries.descriptionFallback"),
    category: "Custom Commands",
    keywords: [cmd.name, ...(cmd.description ? cmd.description.split(/\s+/).filter(Boolean) : [])],
    action: async () => {
      const sessionId = activeSessionId().get(instanceId)
      if (!sessionId || sessionId === "info") {
        showAlertDialog(tGlobal("commands.custom.sessionRequired.message"), {
          title: tGlobal("commands.custom.sessionRequired.title"),
          variant: "warning",
        })
        return
      }
      try {
        const args = await promptForCommandArguments(cmd)
        if (args === null) {
          return
        }
        await executeCustomCommand(instanceId, sessionId, cmd.name, args)
      } catch (error) {
        log.error("Failed to run custom command", error)
        showAlertDialog(tGlobal("commands.custom.runFailed.message"), {
          title: tGlobal("commands.custom.runFailed.title"),
          variant: "error",
        })
      }
    },
  }))
}
