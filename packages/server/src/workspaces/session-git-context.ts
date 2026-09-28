import type { OpenCodeClient } from "@opencode/client"
import { readGitStatus } from "./git-requirement"

const KEY = "codenomad.git-availability"

/** Advisory context, scoped to the already-authorized native session. Replace or
 * remove only our own entry on each agent send, so installation does not leave a
 * stale warning behind. The backend host and the agent's execution host can differ.
 */
export async function syncSessionGitContext(client: OpenCodeClient, sessionID: string, disconnected: AbortSignal): Promise<void> {
  const deadline = new AbortController()
  const signal = AbortSignal.any([disconnected, deadline.signal])
  const timer = setTimeout(() => deadline.abort(new Error("Git context deadline exceeded")), 2_000)
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    // Include a Git probe queued behind other work, not only the HTTP operation.
    await Promise.race([updateContext(client, sessionID, signal), aborted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}

async function updateContext(client: OpenCodeClient, sessionID: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const status = await readGitStatus()
  signal.throwIfAborted()
  if (status.available) {
    await client.session.instructions.entry.remove({ sessionID, key: KEY }, { signal })
    return
  }
  await client.session.instructions.entry.put({ sessionID, key: KEY, value: {
    backendPlatform: status.platform,
    gitAvailable: false,
    context: "CodeNomad cannot run Git from its backend process PATH. Git is a prerequisite for full functionality, but directory-only conversation access is tolerated so the user can consult you and ask for installation help. CodeNomad Git operations and worktree discovery, creation, removal and moves are unavailable. Session access is limited to the explicitly opened physical folder; other checkouts can be opened separately. The agent's execution host may differ from the CodeNomad backend (for example WSL or a remote connection): Git working in your shell does not prove it works in the backend. Help install Git for the backend account when requested. Windows supports per-user installation without administrator rights; on Linux/macOS choose an installation method appropriate to the user's permissions and existing tools. After changing the backend PATH, fully restart CodeNomad or its server process. Do not restart the shared OpenCode daemon just to refresh CodeNomad's PATH. This context reports a dependency limitation, not a request to interrupt the user's current task.",
  } }, { signal })
}
