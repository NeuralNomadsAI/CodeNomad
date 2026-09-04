const encoder = new TextEncoder()

export const HOST_ID_PATTERN = /^[a-f0-9]{32}$/
export const DEVICE_COOKIE = "codenomad_remote_device"
export const RELAY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const HOST_SECRET_PATTERN = /^[A-Za-z0-9_-]{40,128}$/

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? ""
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

export function cookieToken(request: Request): string | null {
  const cookies = request.headers.get("cookie") ?? ""
  for (const entry of cookies.split(";")) {
    const [name, ...parts] = entry.trim().split("=")
    if (name === DEVICE_COOKIE) {
      try {
        return decodeURIComponent(parts.join("="))
      } catch {
        return null
      }
    }
  }
  return null
}

export function deviceCookie(token: string, maxAgeSeconds: number): string {
  return `${DEVICE_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`
}

export function clearDeviceCookie(): string {
  return `${DEVICE_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
}
