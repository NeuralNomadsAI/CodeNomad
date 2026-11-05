import fs from "node:fs"
import path from "node:path"

// prototype-1236: an `opencode pair` token or a manually entered password survives restarts
// like a paired CodeNomad server's device cookie: a token until its 30-day expiry or a 401,
// a password until a 401 or removal. Backend-only, mode 0600. Never logged, never returned
// to a browser, never written to the configuration.
const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
type TokenEntry = { key: string; token: string; expiresAt: number }
type PasswordEntry = { key: string; credential: string }
type Entry = TokenEntry | PasswordEntry

function validEntry(entry: unknown): entry is Entry {
  if (!entry || typeof entry !== "object") return false
  const value = entry as Record<string, unknown>
  if (typeof value.key !== "string") return false
  if (typeof value.token === "string") return typeof value.expiresAt === "number"
  return typeof value.credential === "string"
}

export class PairingTokenStore {
  #entries = new Map<string, Entry>()

  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as { pairings?: Record<string, unknown> }
      for (const [id, entry] of Object.entries(value.pairings ?? {})) if (validEntry(entry)) this.#entries.set(id, entry)
    } catch { /* No pairing yet, or an unreadable file: re-pairing replaces it. */ }
  }

  /** The connection credential (`{ username, password }` JSON) for this exact server key. */
  read(serverId: string, key: string): string | null {
    const entry = this.#entries.get(serverId)
    if (!entry) return null
    if (entry.key !== key || ("token" in entry && entry.expiresAt <= this.now())) { this.delete(serverId); return null }
    return "token" in entry ? pairedCredential(entry.token) : entry.credential
  }

  has(serverId: string, key: string): boolean {
    const entry = this.#entries.get(serverId)
    return entry?.key === key && (!("token" in entry) || entry.expiresAt > this.now())
  }

  set(serverId: string, key: string, token: string): void {
    this.#entries.set(serverId, { key, token, expiresAt: tokenExpiry(token, this.now()) })
    this.persist()
  }

  /** A manual `{ username, password }` credential, kept until a 401 or removal. */
  setCredential(serverId: string, key: string, credential: string): void {
    this.#entries.set(serverId, { key, credential })
    this.persist()
  }

  delete(serverId: string): void {
    if (this.#entries.delete(serverId)) this.persist()
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify({ pairings: Object.fromEntries(this.#entries) })}\n`, { mode: 0o600 })
    fs.renameSync(temporary, this.filePath)
  }
}

/** OpenCode accepts a paired token wherever its password is accepted, as Basic `opencode:<token>`. */
function pairedCredential(token: string): string {
  return JSON.stringify({ username: "opencode", password: token })
}

/** OpenCode tokens are `<expires>.<hmac>`; fall back to its fixed 30-day lifetime. */
function tokenExpiry(token: string, now: number): number {
  const prefix = Number(token.split(".")[0])
  if (!Number.isFinite(prefix) || prefix <= 0) return now + TOKEN_LIFETIME_MS
  const ms = prefix < 1e12 ? prefix * 1000 : prefix
  // An unrecognized prefix never rejects a token early; the server's 401 decides.
  return ms > now ? Math.min(ms, now + TOKEN_LIFETIME_MS) : now + TOKEN_LIFETIME_MS
}
