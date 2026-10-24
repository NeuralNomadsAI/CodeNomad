import { dialog, shell } from "electron"

/** The host owns opening and reports asynchronous failures; never replay a launch. */
export async function openExternalWithFeedback(url: string): Promise<void> {
  try {
    await shell.openExternal(url)
  } catch (error) {
    console.error("[electron] failed to open external URL", error)
    dialog.showErrorBox("CodeNomad", "Could not open the link in your browser. Open it manually from the help or support page.")
  }
}
