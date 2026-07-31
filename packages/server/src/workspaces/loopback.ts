/**
 * Loopback host used for direct in-process communication with a running
 * OpenCode workspace instance (the server and the instance share a machine).
 *
 * Shared by the workspace-instance loopback callers so they agree on the host
 * instead of each hardcoding their own `127.0.0.1` literal.
 */
export const LOOPBACK_HOST = "127.0.0.1"
