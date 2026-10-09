import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { RemoteControlDevice, RemoteControlPairing } from "../api-types"

export const PAIRING_TTL_MS = 5 * 60_000
export const DEVICE_IDLE_EXPIRY_MS = 30 * 24 * 60 * 60_000
const LAST_SEEN_PERSIST_MS = 10 * 60_000
const MAX_DEVICES = 32
const MAX_NAME_CHARS = 80

interface StoredDevice {
  id: string
  name: string
  tokenHash: string
  createdAt: string
  lastSeenAt: string
}

interface StoredState {
  version: 1
  route: string
  devices: StoredDevice[]
}

/**
 * Host-owned Remote Control authorization: the stable tunnel route, one
 * single-use pairing code at a time, and hashed device credentials that expire
 * after a period without use.
 */
export class RemoteDeviceRegistry {
  private state: StoredState
  private pairing: { codeHash: Buffer; expiresAt: number } | null = null
  private readonly persistedLastSeen = new Map<string, number>()
  private persisted: boolean

  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {
    const stored = readState(filePath)
    this.state = stored ?? { version: 1, route: newRoute(), devices: [] }
    this.persisted = stored !== null
    this.pruneExpired()
  }

  /** The tunnel route, stored on first use so installations that never enable Remote Control write nothing. */
  route(): string {
    if (!this.persisted) this.persist()
    return this.state.route
  }

  /** Issues a new pairing code; any earlier unused code stops working. */
  createPairing(): { code: string; expiresAt: string } {
    const code = randomBytes(24).toString("base64url")
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.pairing = { codeHash: hash(code), expiresAt }
    return { code, expiresAt: new Date(expiresAt).toISOString() }
  }

  cancelPairing(): void {
    this.pairing = null
  }

  /**
   * Consumes a pairing code once and returns the new device credential. At the
   * device limit, the least recently seen device is replaced and reported.
   */
  exchange(code: string, name: string): { device: RemoteControlDevice; token: string; evictedId?: string } | null {
    const pairing = this.pairing
    if (!pairing || pairing.expiresAt <= this.now() || !timingSafeEqual(pairing.codeHash, hash(code))) return null
    this.pairing = null
    this.pruneExpired()
    let evictedId: string | undefined
    if (this.state.devices.length >= MAX_DEVICES) {
      evictedId = this.state.devices.sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt)).shift()?.id
      if (evictedId) this.persistedLastSeen.delete(evictedId)
    }
    const token = randomBytes(32).toString("base64url")
    const timestamp = new Date(this.now()).toISOString()
    const stored: StoredDevice = {
      id: randomUUID(),
      name: sanitizeName(name),
      tokenHash: hash(token).toString("hex"),
      createdAt: timestamp,
      lastSeenAt: timestamp,
    }
    this.state.devices.push(stored)
    this.persist()
    return { device: publicDevice(stored), token, ...(evictedId ? { evictedId } : {}) }
  }

  authenticate(token: string | undefined): RemoteControlDevice | null {
    if (!token) return null
    const tokenHash = hash(token).toString("hex")
    const device = this.state.devices.find((candidate) => candidate.tokenHash === tokenHash)
    if (!device || this.isExpired(device)) return null
    const now = this.now()
    device.lastSeenAt = new Date(now).toISOString()
    if (now - (this.persistedLastSeen.get(device.id) ?? 0) >= LAST_SEEN_PERSIST_MS) {
      this.persistedLastSeen.set(device.id, now)
      this.persist()
    }
    return publicDevice(device)
  }

  list(): RemoteControlDevice[] {
    this.pruneExpired()
    return this.state.devices.map(publicDevice)
  }

  revoke(id: string): boolean {
    const before = this.state.devices.length
    this.state.devices = this.state.devices.filter((device) => device.id !== id)
    if (this.state.devices.length === before) return false
    this.persistedLastSeen.delete(id)
    this.persist()
    return true
  }

  private isExpired(device: StoredDevice): boolean {
    return Date.parse(device.lastSeenAt) + DEVICE_IDLE_EXPIRY_MS <= this.now()
  }

  private pruneExpired(): void {
    const kept = this.state.devices.filter((device) => !this.isExpired(device))
    if (kept.length === this.state.devices.length) return
    this.state.devices = kept
    this.persist()
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, this.filePath)
    this.persisted = true
  }
}

export function pairingFromCode(origin: string, code: { code: string; expiresAt: string }): RemoteControlPairing {
  // The code stays in the fragment, so it never reaches request logs or Referer headers.
  return { url: `${origin}/remote-pair#${code.code}`, expiresAt: code.expiresAt }
}

/** A short device label from the browser's User-Agent. */
export function deviceNameFromUserAgent(userAgent: string | undefined): string {
  const agent = userAgent ?? ""
  const platform = /iPhone/.test(agent) ? "iPhone"
    : /iPad/.test(agent) ? "iPad"
    : /Android/.test(agent) ? "Android"
    : /Windows/.test(agent) ? "Windows"
    : /Mac OS X|Macintosh/.test(agent) ? "macOS"
    : /Linux/.test(agent) ? "Linux"
    : "Device"
  const browser = /Edg\//.test(agent) ? "Edge"
    : /Firefox\//.test(agent) ? "Firefox"
    : /Chrome\//.test(agent) ? "Chrome"
    : /Safari\//.test(agent) ? "Safari"
    : "Browser"
  return `${platform} · ${browser}`
}

function readState(filePath: string): StoredState | null {
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  const candidate = value as Partial<StoredState>
  if (candidate.version !== 1 || typeof candidate.route !== "string" || !isRoute(candidate.route) || !Array.isArray(candidate.devices)) return null
  const devices = candidate.devices.filter((device): device is StoredDevice =>
    typeof device === "object" && device !== null
    && typeof device.id === "string" && typeof device.name === "string" && /^[0-9a-f]{64}$/.test(String(device.tokenHash))
    && !Number.isNaN(Date.parse(String(device.createdAt))) && !Number.isNaN(Date.parse(String(device.lastSeenAt))))
  return { version: 1, route: candidate.route, devices }
}

function publicDevice(device: StoredDevice): RemoteControlDevice {
  return { id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt }
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_CHARS)
  return cleaned || "Device"
}

function newRoute(): string {
  // A random label keeps the address unguessable; it is never an authorization factor.
  return `codenomad-${randomBytes(6).toString("hex")}`
}

function isRoute(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest()
}
