import type { Instance } from "../types/instance"
import type { Session } from "../types/session"

/** Internal inventory policy: explicit paths are exact native Location identities. */
export function explicitSessionDirectory(instance: Instance | undefined): string | undefined {
  return instance?.binding && instance.binding.serverId !== "local-shared" ? instance.binding.directory : undefined
}

export function sessionMatchesInventory(instance: Instance | undefined, session: { location?: { directory: string; workspaceID?: string } }): boolean {
  const directory = explicitSessionDirectory(instance)
  return directory === undefined || (session.location?.directory === directory && session.location.workspaceID === undefined)
}

export function scopedSessionMap(instance: Instance | undefined, sessions: Map<string, Session>): Map<string, Session> {
  return explicitSessionDirectory(instance) === undefined ? sessions
    : new Map([...sessions].filter(([, session]) => sessionMatchesInventory(instance, session)))
}
