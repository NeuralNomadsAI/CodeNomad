import type { AuthManager } from "./manager"

const request = /^codenomad:renew-session ([a-f0-9-]{36})$/
const response = "CODENOMAD_MANAGED_SESSION:"

/** The credential travels only over the attached parent's process pipes. */
export function handleManagedSessionControl(line: string, auth: AuthManager,
  send: (line: string) => void): boolean {
  const match = request.exec(line)
  if (!match) return false
  send(`${response}${match[1]} ${auth.renewManagedSession() ?? "-"}`)
  return true
}
