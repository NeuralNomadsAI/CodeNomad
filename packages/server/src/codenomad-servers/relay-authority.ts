/** Local relay generation, never an upstream credential or persisted identity. */
export const RELAY_AUTHORITY_HEADER = "x-codenomad-backend-authority"
export const RELAY_AUTHORITY_QUERY = "__codenomad_authority"
export const RELAY_BOOTSTRAP = "bootstrap"
export const isRelayAuthority = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
