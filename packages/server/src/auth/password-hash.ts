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

export function hashPassword(password: string): PasswordHashRecord {
  const salt = crypto.randomBytes(16)
  const params = DEFAULT_SCRYPT_PARAMS
  const keyLength = 64
  const derived = crypto.scryptSync(password, salt, keyLength, params)
  return {
    algorithm: "scrypt",
    saltBase64: salt.toString("base64"),
    hashBase64: Buffer.from(derived).toString("base64"),
    keyLength,
    params,
  }
}

export function verifyPassword(password: string, record: PasswordHashRecord): boolean {
  if (record.algorithm !== "scrypt") {
    return false
  }

  const salt = Buffer.from(record.saltBase64, "base64")
  const expected = Buffer.from(record.hashBase64, "base64")
  const derived = crypto.scryptSync(password, salt, record.keyLength, record.params)
  if (expected.length !== derived.length) {
    return false
  }
  return crypto.timingSafeEqual(expected, Buffer.from(derived))
}
