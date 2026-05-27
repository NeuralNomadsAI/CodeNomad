import crypto from "node:crypto"

export const OPENCODE_SERVER_USERNAME_ENV = "OPENCODE_SERVER_USERNAME" as const
export const OPENCODE_SERVER_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD" as const
export const OPENCODE_SERVER_BASE_URL_ENV = "OPENCODE_SERVER_BASE_URL" as const

export const DEFAULT_OPENCODE_USERNAME = "codenomad" as const

export function generateOpencodeServerPassword(): string {
  return crypto.randomBytes(32).toString("base64url")
}

function readConfiguredValue(key: string, ...sources: Array<Record<string, unknown> | undefined>): string | undefined {
  for (const source of sources) {
    const value = source?.[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

export function resolveOpencodeServerAuth(options: {
  userEnvironment?: Record<string, unknown>
  processEnv?: NodeJS.ProcessEnv
  generatePassword?: () => string
} = {}): { username: string; password: string } {
  const generatePassword = options.generatePassword ?? generateOpencodeServerPassword
  const username =
    readConfiguredValue(OPENCODE_SERVER_USERNAME_ENV, options.userEnvironment, options.processEnv) ??
    DEFAULT_OPENCODE_USERNAME
  const password =
    readConfiguredValue(OPENCODE_SERVER_PASSWORD_ENV, options.userEnvironment, options.processEnv) ??
    generatePassword()

  return { username, password }
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
