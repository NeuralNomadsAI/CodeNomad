// The Design request a backend carries in each of its session-pruning leases.
// Shared by the backend that writes it and the daemon-loaded plugin that reads it.

/** Leases larger than this request nothing and are never read further. */
export const DESIGN_LEASE_MAX_BYTES = 256
const DESIGN_REQUEST = JSON.stringify({ version: 1, design: true })

/** The lease content of a backend: empty when it requests nothing. */
export function designLeaseContent(requested: boolean): string {
  return requested ? DESIGN_REQUEST : ""
}

/** Only an exact version 1 request counts; empty, malformed or unknown versions request nothing. */
export function leaseRequestsDesign(content: string): boolean {
  if (!content) return false
  try {
    const value: unknown = JSON.parse(content)
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
      && (value as { version?: unknown }).version === 1 && (value as { design?: unknown }).design === true
  } catch {
    return false
  }
}
