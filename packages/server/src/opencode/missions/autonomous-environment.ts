import path from "node:path"
import { z } from "zod"
import { canonicalAuthority, rejectAuthority, type AuthorityBinding } from "../../missions/authority-protocol"
import { readAdmissionEnvironment } from "../../settings/admission-environment"
import { sessionEnvironment } from "../../workspaces/session-environment"

const profileSchema = z.object({ profileID: z.string().min(1).max(240), executionHost: z.string().min(1).max(240),
  configYamlPath: z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0")),
}).strict()
export type AutonomousProfileSource = z.infer<typeof profileSchema>

/** Called inside OpenCode on its execution host, never with the desktop's ENV or
 * a guessed WSL translation. The native owner must provision this exact source;
 * ctx.options/browser JSON/plugin storage alone cannot establish its ownership.
 * Values are read afresh per send; only profile/source identity is pinned. */
export async function readAutonomousMissionEnvironment(scope: Pick<AuthorityBinding, "profileID" | "executionHost">,
  raw: AutonomousProfileSource, signal: AbortSignal,
  host: { environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) {
  signal.throwIfAborted()
  canonicalAuthority(raw)
  const source = profileSchema.parse(raw)
  if (source.profileID !== scope.profileID || source.executionHost !== scope.executionHost) rejectAuthority("binding-mismatch")
  const configured = await readAdmissionEnvironment(source, signal, true)
  signal.throwIfAborted()
  const variables = await sessionEnvironment(configured, host)
  signal.throwIfAborted()
  return Object.freeze(variables)
}
