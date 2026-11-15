/**
 * Administrator network policy, read from the environment the backend inherits (machine-wide
 * variables reach every desktop launch). Users cannot change it from the UI, and an unknown value
 * refuses startup rather than leaving a feature open.
 *
 * - `CODENOMAD_REMOTE_CONTROL=disabled`: Remote Control never connects a tunnel or pairs a device.
 * - `CODENOMAD_LOCKED_HOST=<address>`: the listening address, whatever `--host` or the listening
 *   switch request (an intranet address for shared use, `127.0.0.1` for this machine only).
 */
export interface NetworkPolicy {
  remoteControlDisabled: boolean
  /** Raw administrator address; resolved and validated like `--host`. */
  lockedHost?: string
}

export class NetworkPolicyError extends Error {
  override readonly name = "NetworkPolicyError"
}

export function readNetworkPolicy(env: NodeJS.ProcessEnv = process.env): NetworkPolicy {
  const remoteControl = env.CODENOMAD_REMOTE_CONTROL?.trim().toLowerCase() ?? ""
  if (remoteControl !== "" && remoteControl !== "disabled") {
    throw new NetworkPolicyError("CODENOMAD_REMOTE_CONTROL accepts only \"disabled\"")
  }
  const lockedHost = env.CODENOMAD_LOCKED_HOST?.trim()
  return { remoteControlDisabled: remoteControl === "disabled", ...(lockedHost ? { lockedHost } : {}) }
}
