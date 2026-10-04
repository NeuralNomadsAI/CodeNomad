import { createHash } from "node:crypto"
import path from "node:path"

export const VERSION = 1
export const MAX_BYTES = 256 * 1024
export const TIMEOUT_MS = 5_000
export class HostError extends Error {
  constructor(readonly code: string) { super(code) }
}
export interface Scope { channel: string; configIdentity: string; key: string }
/** Matches the desktop lexical identity, not filesystem realpath aliases. */
export function canonicalScope(channel: string, config: string, cwd: string, home: string): Scope {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(channel)) throw new HostError("invalid-channel")
  const value = config.trim() || "~/.config/codenomad/config.json"
  let identity = path.resolve(cwd, value === "~" ? home : /^~[/\\]/.test(value) ? path.join(home, value.slice(2)) : value)
  const extension = path.extname(identity).toLowerCase()
  if (extension === ".json") identity = path.join(path.dirname(identity), "config.yaml")
  else if (extension !== ".yaml" && extension !== ".yml") identity = path.join(identity, "config.yaml")
  if (process.platform === "win32") identity = identity.replace(/\//g, "\\").toLowerCase()
  return { channel, configIdentity: identity, key: createHash("sha256").update(`${channel}\0${identity}`).digest("hex") }
}
export function validateScope(scope: Scope): void {
  if (!scope || canonicalScope(scope.channel, scope.configIdentity, process.cwd(), process.cwd()).key !== scope.key)
    throw new HostError("scope-mismatch")
}
export interface Owner { pid: number; startIdentity: string }
export function validateOwner(owner: Owner): void {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.startIdentity !== "string"
    || !owner.startIdentity || owner.startIdentity.length > 512) throw new HostError("invalid-owner")
}
export interface Registration {
  v: 1; scope: Scope; generation: string; owner: Owner; backend: Owner; origin: string; controlOrigin: string
}
export interface Attachment {
  generation: string; managerPid: number; backendPid: number; origin: string; windowId: string
  capability: string; bootstrapProof: string
}
export interface NativeCall { id: string; method: string; params: unknown; deadline: number; windowId?: string }
export function localOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new HostError("invalid-local-origin") }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) throw new HostError("invalid-local-origin")
  return url.origin
}
export function validateRegistration(value: Registration, scope: Scope): void {
  validateScope(scope)
  if (!value || value.v !== VERSION || value.scope?.key !== scope.key
    || value.scope.channel !== scope.channel || value.scope.configIdentity !== scope.configIdentity
    || !/^[a-f0-9-]{36}$/.test(value.generation)) throw new HostError("invalid-registration")
  for (const owner of [value.owner, value.backend]) validateOwner(owner)
  localOrigin(value.origin); localOrigin(value.controlOrigin)
}
