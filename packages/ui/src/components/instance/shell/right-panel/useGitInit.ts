import { createSignal, onCleanup, type Accessor } from "solid-js"
import { serverApi } from "../../../../lib/api-client"
import { invalidateFilesystemCaches } from "../../../../lib/filesystem-events"
import { loadInstanceProjectMetadata } from "../../../../lib/hooks/use-instance-metadata"
import { getLogger } from "../../../../lib/logger"
import { showToastNotification } from "../../../../lib/notifications"
import { HttpResponseError } from "../../../../lib/retryable-file-search"
import { instances } from "../../../../stores/instances"
import { reloadWorktrees } from "../../../../stores/worktrees"
import { getProjectAvailability } from "../../../../stores/project-capability"
import { captureInstanceRequestAuthority } from "../../../../stores/session-api"

const log = getLogger("api")

const ERROR_KEYS: Record<string, string> = {
  git_init_unsupported: "filesPanel.gitInit.unsupported",
  git_init_repository_exists: "filesPanel.gitInit.exists",
  git_init_directory_mismatch: "filesPanel.gitInit.mismatch",
  git_required: "filesPanel.gitInit.gitRequired",
}

// Shared workspace refusals carry no code: never show their English server text.
function errorKey(error: unknown) {
  if (!(error instanceof HttpResponseError)) return undefined
  if (error.code && ERROR_KEYS[error.code]) return ERROR_KEYS[error.code]
  if (error.status === 403 || error.status === 404) return "filesPanel.gitInit.notOwned"
  if (error.status === 409) return "filesPanel.gitInit.deleting"
  return undefined
}

/** Explicit, non-blocking Git initialization of the opened folder. A request is
 * sent once; success and every failure (including uncertain ones) only re-read
 * the authoritative inventory, project and sessions, never resend. */
export function useGitInit(options: {
  instanceId: string
  directory: Accessor<string>
  t: (key: string, vars?: Record<string, any>) => string
}) {
  const [pending, setPending] = createSignal(false)
  const sourceCurrent = captureInstanceRequestAuthority(options.instanceId)
  const allowed = () => !disposed && sourceCurrent() && getProjectAvailability(options.instanceId, "git").allowed
    && getProjectAvailability(options.instanceId, "hostGit").allowed
  let disposed = false
  onCleanup(() => { disposed = true })

  const refreshAfterAttempt = async () => {
    if (!allowed()) return
    invalidateFilesystemCaches(options.instanceId)
    const instance = instances().get(options.instanceId)
    // A markerless folder's native project changes with its repository. Reload the
    // project before sessions so later list pages use the current project scope.
    const projectMetadata = instance ? loadInstanceProjectMetadata(instance, { force: true }) : Promise.resolve()
    const refreshes = await Promise.allSettled([
      reloadWorktrees(options.instanceId),
      import("../../../../stores/session-api").then(({ fetchSessions }) =>
        allowed() ? fetchSessions(options.instanceId, { reset: true, strictStatus: true, projectMetadata }) : undefined),
    ])
    for (const refresh of refreshes) {
      if (refresh.status === "rejected") log.warn("Refresh after Git initialization failed", { instanceId: options.instanceId, error: refresh.reason })
    }
  }

  const initialize = async () => {
    if (pending() || !allowed()) return
    setPending(true)
    try {
      await serverApi.initializeWorkspaceGit(options.instanceId, options.directory())
      if (allowed()) showToastNotification({ category: "files", message: options.t("filesPanel.gitInit.success"), variant: "success" })
    } catch (error) {
      const key = errorKey(error)
      if (allowed()) showToastNotification({ category: "files",
        message: key ? options.t(key) : options.t("filesPanel.gitInit.error", { message: error instanceof Error ? error.message : String(error) }),
        variant: "error",
      })
    } finally {
      await refreshAfterAttempt()
      if (!disposed) setPending(false)
    }
  }

  // Explicit refresh notices a repository created outside CodeNomad.
  const recheck = () => allowed() ? reloadWorktrees(options.instanceId).catch(error => log.warn("Failed to recheck repository", { instanceId: options.instanceId, error })) : Promise.resolve()

  return { pending, initialize, recheck }
}
