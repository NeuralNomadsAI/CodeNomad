import crypto from "crypto"

export interface PasswordHashRecord {
  algorithm: "scrypt"
  saltBase64: string
  hashBase64: string
  keyLength: number
  params: {
    N: number
    r: number
    p: number
    maxmem: number
  }
}

const DEFAULT_SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
}

// Startup-only: AuthManager initializes its CLI/env override before serving HTTP.
export function hashPasswordSync(password: string): PasswordHashRecord {
  const salt = crypto.randomBytes(16)
  const params = DEFAULT_SCRYPT_PARAMS
  const keyLength = 64
  const derived = crypto.scryptSync(password, salt, keyLength, params)
  return buildRecord(salt, derived, keyLength, params)
}

export async function hashPassword(password: string): Promise<PasswordHashRecord> {
  const salt = crypto.randomBytes(16)
  const params = DEFAULT_SCRYPT_PARAMS
  const keyLength = 64
  const derived = await derivePassword(password, salt, keyLength, params)
  return buildRecord(salt, derived, keyLength, params)
}

function buildRecord(salt: Buffer, derived: Buffer, keyLength: number, params: PasswordHashRecord["params"]): PasswordHashRecord {
  return {
    algorithm: "scrypt",
    saltBase64: salt.toString("base64"),
    hashBase64: Buffer.from(derived).toString("base64"),
    keyLength,
    params,
  }
}

export async function verifyPassword(password: string, record: PasswordHashRecord): Promise<boolean> {
  if (record.algorithm !== "scrypt") {
    return false
  }

  const salt = Buffer.from(record.saltBase64, "base64")
  const expected = Buffer.from(record.hashBase64, "base64")
  const derived = await derivePassword(password, salt, record.keyLength, record.params)
  if (expected.length !== derived.length) {
    return false
  }
  return crypto.timingSafeEqual(expected, Buffer.from(derived))
}

function derivePassword(password: string, salt: Buffer, keyLength: number, params: PasswordHashRecord["params"]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, params, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}
