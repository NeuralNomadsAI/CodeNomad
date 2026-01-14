import crypto from "node:crypto"

export const OPENCODE_SERVER_USERNAME_ENV = "OPENCODE_SERVER_USERNAME" as const
export const OPENCODE_SERVER_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD" as const

export const DEFAULT_OPENCODE_USERNAME = "codenomad" as const

export function generateOpencodeServerPassword(): string {
  return crypto.randomBytes(32).toString("base64url")
}

export function buildOpencodeBasicAuthHeader(params: { username?: string; password?: string }): string | undefined {
  const username = params.username
  const password = params.password

  if (!username || !password) {
    return undefined
  }

  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64")
  return `Basic ${token}`
}
