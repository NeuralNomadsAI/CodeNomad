import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type JsonWebKey as NodeJsonWebKey } from "crypto"
import fs from "fs"
import path from "path"

export interface RemoteControlIdentity {
  hostId: string
  secret: string
  encryptionPrivateKey: JsonWebKey
  encryptionPublicKey: JsonWebKey
}

const HOST_ID_PATTERN = /^[a-f0-9]{32}$/
const SECRET_PATTERN = /^[A-Za-z0-9_-]{40,128}$/

export function loadOrCreateRemoteControlIdentity(configDir: string): RemoteControlIdentity {
  const filePath = path.join(configDir, "remote-control.json")
  const existing = readIdentity(filePath)
  if (existing) return existing

  const encryption = createEncryptionKeyPair()
  const identity = {
    hostId: randomBytes(16).toString("hex"),
    secret: randomBytes(32).toString("base64url"),
    ...encryption,
  }
  writeIdentity(filePath, identity)
  return identity
}

function writeIdentity(filePath: string, identity: RemoteControlIdentity): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  fs.renameSync(temporary, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Windows ACLs and some network filesystems do not implement POSIX modes.
  }
}

function readIdentity(filePath: string): RemoteControlIdentity | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<RemoteControlIdentity>
    if (!HOST_ID_PATTERN.test(value.hostId ?? "") || !SECRET_PATTERN.test(value.secret ?? "")) return null
    if (isPrivateKey(value.encryptionPrivateKey) && isPublicKey(value.encryptionPublicKey)
      && isMatchingKeyPair(value.encryptionPrivateKey, value.encryptionPublicKey)) {
      return {
        hostId: value.hostId!,
        secret: value.secret!,
        encryptionPrivateKey: value.encryptionPrivateKey,
        encryptionPublicKey: value.encryptionPublicKey,
      }
    }
    const migrated = { hostId: value.hostId!, secret: value.secret!, ...createEncryptionKeyPair() }
    writeIdentity(filePath, migrated)
    return migrated
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function createEncryptionKeyPair(): Pick<RemoteControlIdentity, "encryptionPrivateKey" | "encryptionPublicKey"> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  return {
    encryptionPrivateKey: privateKey.export({ format: "jwk" }),
    encryptionPublicKey: publicKey.export({ format: "jwk" }),
  }
}

function isPublicKey(value: JsonWebKey | undefined): value is JsonWebKey {
  return value?.kty === "EC" && value.crv === "P-256"
    && typeof value.x === "string" && typeof value.y === "string"
}

function isPrivateKey(value: JsonWebKey | undefined): value is JsonWebKey {
  return isPublicKey(value) && typeof value.d === "string"
}

function isMatchingKeyPair(privateKey: JsonWebKey, publicKey: JsonWebKey): boolean {
  try {
    const derived = createPublicKey(createPrivateKey({ key: privateKey as NodeJsonWebKey, format: "jwk" })).export({ format: "jwk" })
    return derived.kty === publicKey.kty && derived.crv === publicKey.crv
      && derived.x === publicKey.x && derived.y === publicKey.y
  } catch {
    return false
  }
}
