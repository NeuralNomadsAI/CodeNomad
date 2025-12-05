import type { Command } from "./commands"
import type { Command as SDKCommand } from "@opencode-ai/sdk"
import { showAlertDialog } from "../stores/alerts"
import { activeSessionId, executeCustomCommand } from "../stores/sessions"
import { getLogger } from "./logger"

const log = getLogger("actions")

export function commandRequiresArguments(template?: string): boolean {
  if (!template) return false
  return /\$(?:\d+|ARGUMENTS)/.test(template)
}

export function promptForCommandArguments(command: SDKCommand): string | null {
  if (!commandRequiresArguments(command.template)) {
    return ""
  }
  const input = window.prompt(`Arguments for /${command.name}`, "")
  if (input === null) {
    return null
  }
  return input
}

function formatCommandLabel(name: string): string {
  if (!name) return ""
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function buildCustomCommandEntries(instanceId: string, commands: SDKCommand[]): Command[] {
  return commands.map((cmd) => ({
    id: `custom:${instanceId}:${cmd.name}`,
    label: formatCommandLabel(cmd.name),
    description: cmd.description ?? "Custom command",
    category: "Custom Commands",
    keywords: [cmd.name, ...(cmd.description ? cmd.description.split(/\s+/).filter(Boolean) : [])],
    action: async () => {
      const sessionId = activeSessionId().get(instanceId)
      if (!sessionId || sessionId === "info") {
        showAlertDialog("Select a session before running a custom command.", {
          title: "Session required",
          variant: "warning",
        })
        return
      }
      const args = promptForCommandArguments(cmd)
      if (args === null) {
        return
      }
      try {
        await executeCustomCommand(instanceId, sessionId, cmd.name, args)
      } catch (error) {
        log.error("Failed to run custom command", error)
        showAlertDialog("Failed to run custom command. Check the console for details.", {
          title: "Command failed",
          variant: "error",
        })
      }
    },
  }))
}
