import { createSignal } from "solid-js"
import type { WorkspaceDescriptor } from "../../../server/src/api-types"
import { tGlobal } from "../lib/i18n"
import { formatLaunchErrorMessage, isMissingBinaryMessage } from "../lib/launch-errors"

type LaunchErrorSource = "create" | "workspace"

export interface LaunchErrorState {
  source: LaunchErrorSource
  message: string
  binaryPath: string
  missingBinary: boolean
  instanceId?: string
}

const [launchError, setLaunchError] = createSignal<LaunchErrorState | null>(null)

// Avoid spamming the user with the same modal on repeated events.
const lastWorkspaceErrorByInstanceId = new Map<string, string>()

export function showLaunchError(next: LaunchErrorState) {
  setLaunchError(next)
}

export function clearLaunchError() {
  setLaunchError(null)
}

export function showWorkspaceLaunchError(workspace: WorkspaceDescriptor) {
  const instanceId = workspace.id
  const rawMessage = workspace.error
  const message = formatLaunchErrorMessage(rawMessage, tGlobal("app.launchError.fallbackMessage"))

  const previous = lastWorkspaceErrorByInstanceId.get(instanceId)
  if (previous && previous === message) {
    return
  }

  lastWorkspaceErrorByInstanceId.set(instanceId, message)

  const binaryPath = (workspace.binaryLabel || workspace.binaryId || "opencode").trim() || "opencode"
  const missingBinary = isMissingBinaryMessage(message)

  showLaunchError({
    source: "workspace",
    instanceId,
    message,
    binaryPath,
    missingBinary,
  })
}

export { launchError }
