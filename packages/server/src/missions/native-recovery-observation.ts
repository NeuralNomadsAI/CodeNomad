import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { assertMissionRecoveryReady } from "./recovery-readiness"
import { MissionControlError } from "./control-error"
import { observeActiveDescendant, readNativeMissionFamily } from "./native-session-family"
import { runningMissionShellRelation } from "./native-shell-correlation"

// Read-only, bounded and deliberately conservative. This never resumes a tree or
// cancels a permission/Form; the caller still owns authorization and admission.
export async function assertNativeMissionRecoveryReady(client: OpenCodeClient, target: SessionInfo, signal: AbortSignal): Promise<void> {
  try {
    let ids: Set<string>
    try { ids = await readNativeMissionFamily(client, target, signal) }
    catch (error) {
      signal.throwIfAborted()
      // A family too large for the bounded read may still prove ongoing work.
      const active = await client.session.active({ signal })
      if (active[target.id] || await observeActiveDescendant(client, target.id, active, signal)) {
        assertMissionRecoveryReady({ active: true, inboxCount: 0, pendingForms: 0, pendingPermissions: 0, runningShells: 0, runningChildren: 0 })
      }
      throw error
    }
    const location = { directory: target.location.directory }
    const [active, inboxes, shells, forms, permissions] = await Promise.all([
      client.session.active({ signal }),
      Promise.all([...ids].map(sessionID => client.session.inbox.list({ sessionID }, { signal }))),
      client.shell.list({ location }, { signal }),
      client.form.list({ location }, { signal }),
      client.permission.request.list({ location }, { signal }),
    ])
    if ([shells, forms, permissions].some(response => response.location.directory !== location.directory)) throw new Error("Changed location")
    assertMissionRecoveryReady({
      active: Boolean(active[target.id]), inboxCount: inboxes.reduce((count, inbox) => count + inbox.length, 0),
      pendingForms: forms.data.filter(form => form.sessionID === "global" || ids.has(form.sessionID)).length,
      pendingPermissions: permissions.data.filter(permission => permission.sessionID === "global" || ids.has(permission.sessionID)).length,
      // A shell without a native session correlation cannot be proved unrelated.
       runningShells: shells.data.filter(shell => runningMissionShellRelation(shell, ids) !== "unrelated").length,
      runningChildren: [...ids].filter(id => id !== target.id && active[id]).length,
    })
  } catch (error) {
    if (error instanceof MissionControlError || signal.aborted) throw error
    throw new MissionControlError("Native activity is unknown; recovery was not admitted", "recovery-unknown")
  }
}
