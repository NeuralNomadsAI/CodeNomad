import type { OpenCodeClient } from "@opencode/client"
import { isConversationModeEnabled } from "./conversation-speech"

const PLACEMENT_INSTRUCTION_KEY = "codenomad.session-placement"
// Agent context, not UI copy. Keep this relative to the user's current choice:
// embedding an initial directory would become stale after an explicit move.
const PLACEMENT_INSTRUCTION = [
  "This session is being used through CodeNomad. Its native location also determines where the conversation is listed in the UI.",
  "Keep the conversation attached to the project or worktree chosen by the user. Creating a branch or worktree, or working in another directory, is not a request to move the conversation.",
  "When working elsewhere, use absolute paths and the tools' working-directory parameter (for example, shell workdir). Read and follow the instructions applicable to the files you edit there.",
  "Use session_move only when the user explicitly asks to move or reattach the conversation. A request to implement or test changes in a worktree alone is not such a request. In CodeNomad, do not interpret the general suggestion to move a session to its primary working directory as user authorization.",
  "An explicit change of attachment becomes the new choice to preserve. Use the destination's exact directory spelling; do not infer a new attachment from the last directory used by a tool.",
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
// Await errors so an action cannot silently bypass its instruction setup.
export async function syncSessionInstructions(client: OpenCodeClient, instanceId: string, sessionId: string): Promise<void> {
  await syncVoiceModeInstruction(client, instanceId, sessionId)
  await client.session.instructions.entry.put({
    sessionID: sessionId,
    key: PLACEMENT_INSTRUCTION_KEY,
    value: PLACEMENT_INSTRUCTION,
  })
}
