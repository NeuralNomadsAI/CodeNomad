import { createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { closeFilePreview, getFilePreview } from "../../../stores/files-preview"
import { getDefaultWorktreeSlug, getWorktrees, getWorktreeSlugForSession } from "../../../stores/worktrees"

export const sessionWorktreeSlug = (instanceId: string, sessionId: string | null) =>
  sessionId && sessionId !== "info" ? getWorktreeSlugForSession(instanceId, sessionId) : getDefaultWorktreeSlug(instanceId)

/** The central file reader belongs to the project shell, not to the Files panel
 * that opened it: hiding, docking or floating the panel leaves it open. It closes
 * on an explicit close, a session or session-worktree change, the removal of its
 * worktree and the shell's disposal. */
export function useFilePreviewLifetime(instanceId: string, activeSessionId: Accessor<string | null>) {
  const sessionWorktree = createMemo(() => sessionWorktreeSlug(instanceId, activeSessionId()))
  createEffect(on(() => `${activeSessionId()}:${sessionWorktree()}`, () => closeFilePreview(instanceId), { defer: true }))
  createEffect(() => {
    const target = getFilePreview(instanceId)
    const worktrees = getWorktrees(instanceId)
    // A removed worktree must never silently turn into a root-file read.
    if (target && worktrees.length && !worktrees.some(entry => entry.slug === target.slug)) closeFilePreview(instanceId)
  })
  onCleanup(() => closeFilePreview(instanceId))
}
