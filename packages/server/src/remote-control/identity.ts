import { randomBytes } from "crypto"
import fs from "fs"
import path from "path"

export interface RemoteControlIdentity {
  hostId: string
  secret: string
}

const HOST_ID_PATTERN = /^[a-f0-9]{32}$/
const SECRET_PATTERN = /^[A-Za-z0-9_-]{40,}$/

export function loadOrCreateRemoteControlIdentity(configDir: string): RemoteControlIdentity {
  const filePath = path.join(configDir, "remote-control.json")
  const existing = readIdentity(filePath)
  if (existing) return existing

  const identity = {
    hostId: randomBytes(16).toString("hex"),
    secret: randomBytes(32).toString("base64url"),
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  fs.renameSync(temporary, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Windows ACLs and some network filesystems do not implement POSIX modes.
  }
  return identity
}

function readIdentity(filePath: string): RemoteControlIdentity | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<RemoteControlIdentity>
    if (!HOST_ID_PATTERN.test(value.hostId ?? "") || !SECRET_PATTERN.test(value.secret ?? "")) return null
    return { hostId: value.hostId!, secret: value.secret! }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}
