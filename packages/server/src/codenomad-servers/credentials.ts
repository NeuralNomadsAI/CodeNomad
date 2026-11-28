import fs from "node:fs"
import path from "node:path"

/** How this backend authenticates to a relayed CodeNomad server. */
export type CodeNomadServerSecret =
  | { kind: "password"; username: string; password: string; cookie?: string }
  | { kind: "device"; cookie: string }
  | { kind: "session"; cookie: string }

type Entry = { origin: string; skipTlsVerify?: boolean; secret: CodeNomadServerSecret }

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false
  const entry = value as { origin?: unknown; skipTlsVerify?: unknown; secret?: Record<string, unknown> }
  if (typeof entry.origin !== "string" || !entry.secret || typeof entry.secret !== "object") return false
  if (entry.skipTlsVerify !== undefined && typeof entry.skipTlsVerify !== "boolean") return false
  const secret = entry.secret
  if (secret.kind === "password") return typeof secret.username === "string" && typeof secret.password === "string" && (secret.cookie === undefined || typeof secret.cookie === "string")
  return (secret.kind === "device" || secret.kind === "session") && typeof secret.cookie === "string"
}

/** Backend-only, mode 0600, beside the profile's config and never inside it. Kept across
 * launches (password or Remote Control device cookie) until removal or a refused credential.
 * Never logged, never returned to a browser or a paired device. */
export class CodeNomadServerCredentials {
  #entries = new Map<string, Entry>()

  constructor(private readonly filePath: string) {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as { servers?: Record<string, unknown> }
      for (const [id, entry] of Object.entries(value.servers ?? {})) if (validEntry(entry)) this.#entries.set(id, entry)
    } catch { /* No server yet, or an unreadable file: adding the server again replaces it. */ }
  }

  /** The secret, only for the exact origin it was obtained from. */
  read(serverId: string, origin: string, skipTlsVerify = false): CodeNomadServerSecret | undefined {
    const entry = this.#entries.get(serverId)
    if (!entry) return undefined
    if (entry.origin !== origin || (entry.skipTlsVerify ?? false) !== skipTlsVerify) { this.delete(serverId); return undefined }
    return { ...entry.secret }
  }

  has(serverId: string, origin: string, skipTlsVerify = false): boolean {
    const entry = this.#entries.get(serverId)
    return entry?.origin === origin && (entry.skipTlsVerify ?? false) === skipTlsVerify
  }

  ids(): string[] { return [...this.#entries.keys()] }

  set(serverId: string, origin: string, secret: CodeNomadServerSecret, skipTlsVerify = false): void {
    const next = new Map(this.#entries).set(serverId, { origin, skipTlsVerify, secret: { ...secret } })
    this.persist(next)
    this.#entries = next
  }

  delete(serverId: string): void {
    if (!this.#entries.has(serverId)) return
    const next = new Map(this.#entries)
    next.delete(serverId)
    this.persist(next)
    this.#entries = next
  }

  private persist(entries: Map<string, Entry>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify({ servers: Object.fromEntries(entries) })}\n`, { mode: 0o600 })
    fs.chmodSync(temporary, 0o600)
    fs.renameSync(temporary, this.filePath)
  }
}
