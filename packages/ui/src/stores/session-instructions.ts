import type { OpenCodeClient } from "@opencode/client"
import { getLogger } from "../lib/logger"
import { isConversationModeEnabled } from "./conversation-speech"
import { getDefaultWorktreeDirectory } from "./worktrees"

const PLACEMENT_INSTRUCTION_KEY = "codenomad.session-placement"
// Agent context, not UI copy. Keep this relative to the user's current choice:
// embedding an initial directory would become stale after an explicit move.
const PLACEMENT_INSTRUCTION = [
  "This session is being used through CodeNomad. The opened local repository and its Git worktrees form the CodeNomad project. A session's native location is its execution directory; moving between that repository's worktrees keeps it in the same project.",
  "Creating a worktree and moving a conversation are separate actions. Creating a branch or worktree alone does not move this session. A request to continue this conversation's task in a worktree authorizes changing its native location, unless the user explicitly asks to preserve the current location.",
  "When working elsewhere, use absolute paths and the tools' working-directory parameter (for example, shell workdir). Read and follow the instructions applicable to the files you edit there.",
  "Use session_move for an authorized change of the conversation's working context. A one-off command or test in another directory only needs workdir. Never move merely to repair UI classification. Do not independently relocate a child session or assume session_move moves the complete session family; CodeNomad's UI handles family moves.",
  "An explicit change of attachment becomes the new choice to preserve. Use the destination's exact directory spelling; do not infer a new attachment from the last directory used by a tool.",
  "Unless the user specifies another destination, create worktrees under the local main checkout's .codenomad/worktrees directory, not recursively beneath the current linked checkout. Use a named branch starting at the current session checkout's HEAD unless another revision or a detached checkout is requested. Uncommitted changes remain in the original worktree. Preserve Git's refusal to reuse a branch checked out elsewhere; never force or reset it to make creation succeed.",
  "Prefer native worktree operations when available. Native creation can produce a detached checkout: select or create the requested branch with Git without resetting an existing branch. If using Git directly, create an ordinary registered linked worktree, keep .codenomad/worktrees excluded from tracking using Git's resolved info/exclude path, and report its exact directory and branch. CodeNomad discovers registered worktrees regardless of who created them.",
].join("\n\n")

const VOICE_MODE_INSTRUCTION_KEY = "codenomad.voice-mode"
const VOICE_MODE_INSTRUCTION = [
  "Voice conversation mode is enabled.",
  "Prepend your reply with a fenced code block using language `spoken`.",
  "The `spoken` block should be a concise, natural spoken gist of the full response in 2 to 4 sentences.",
  "Do not include code, bullet lists, markdown formatting, or long technical detail in the spoken block.",
  "After the `spoken` block, continue with your normal detailed response.",
].join("\n\n")
const voiceInstructionSyncs = new Map<string, { desired: boolean; running: Promise<void> }>()

async function syncVoiceModeInstruction(client: OpenCodeClient, instanceId: string, sessionId: string): Promise<void> {
  const key = `${instanceId}:${sessionId}`
  const existing = voiceInstructionSyncs.get(key)
  if (existing) {
    existing.desired = isConversationModeEnabled(instanceId)
    return existing.running
  }

  const state = { desired: isConversationModeEnabled(instanceId), running: Promise.resolve() }
  state.running = (async () => {
    try {
      let applied: boolean | undefined
      while (applied !== state.desired) {
        const desired = state.desired
        const instruction = client.session.instructions.entry
        if (desired) {
          await instruction.put({ sessionID: sessionId, key: VOICE_MODE_INSTRUCTION_KEY, value: VOICE_MODE_INSTRUCTION })
        } else {
          await instruction.remove({ sessionID: sessionId, key: VOICE_MODE_INSTRUCTION_KEY })
        }
        applied = desired
        state.desired = isConversationModeEnabled(instanceId)
      }
    } finally {
      if (voiceInstructionSyncs.get(key) === state) voiceInstructionSyncs.delete(key)
    }
  })()
  voiceInstructionSyncs.set(key, state)
  return state.running
}

// Called inside session admission before prompt/command/shell. Reapply the named
// entry for existing sessions and after reconnects, without a browser-only cache.
// Voice mode is a UI preference overlay: its sync never blocks the send itself.
// Placement context remains awaited so an action cannot silently bypass setup.
export async function syncSessionInstructions(client: OpenCodeClient, instanceId: string, sessionId: string): Promise<void> {
  try {
    await syncVoiceModeInstruction(client, instanceId, sessionId)
  } catch (error) {
    getLogger("actions").warn("Voice instruction sync failed; continuing without it", error)
  }
  await client.session.instructions.entry.put({
    sessionID: sessionId,
    key: PLACEMENT_INSTRUCTION_KEY,
    value: [PLACEMENT_INSTRUCTION, getDefaultWorktreeDirectory(instanceId)
      ? `The default worktree parent for this CodeNomad project is: ${getDefaultWorktreeDirectory(instanceId)}`
      : ""].filter(Boolean).join("\n\n"),
  })
}
