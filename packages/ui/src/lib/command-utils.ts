import type { CommandInfo } from "@opencode/client"
import { showAlertDialog, showPromptDialog } from "../stores/alerts"
import { getLogger } from "./logger"
import { tGlobal } from "./i18n"

const log = getLogger("actions")

export async function promptForCommandArguments(command: CommandInfo): Promise<string | null> {
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
