// A feature request a backend carries in its presence leases. Shared by the
// backend that writes it and the daemon-loaded plugins that read it.

/** Leases larger than this request nothing and are never read further. */
export const LEASE_REQUEST_MAX_BYTES = 256

/** The lease content of a backend: empty when it requests nothing. */
export function leaseRequestContent(field: string, requested: boolean): string {
  return requested ? JSON.stringify({ version: 1, [field]: true }) : ""
}

/** Only an exact version 1 request counts; empty, malformed or unknown versions request nothing. */
export function leaseRequests(content: string, field: string): boolean {
  if (!content) return false
  try {
    const value: unknown = JSON.parse(content)
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
      && (value as { version?: unknown }).version === 1 && (value as Record<string, unknown>)[field] === true
  } catch {
    return false
  }
}
