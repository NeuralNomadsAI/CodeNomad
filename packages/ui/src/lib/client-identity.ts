const CLIENT_ID_STORAGE_KEY = "codenomad.client-id"
const CONNECTION_ID_STORAGE_KEY = "codenomad.connection-id"

let cachedClientId: string | null = null
let cachedConnectionId: string | null = null

export function getClientIdentity(): { clientId: string; connectionId: string } {
  return {
    clientId: getOrCreateClientId(),
    connectionId: getOrCreateConnectionId(),
  }
}

function getOrCreateClientId(): string {
  if (cachedClientId) return cachedClientId
  cachedClientId = getOrCreateStoredValue(CLIENT_ID_STORAGE_KEY, window.localStorage)
  return cachedClientId
}

function getOrCreateConnectionId(): string {
  if (cachedConnectionId) return cachedConnectionId
  cachedConnectionId = getOrCreateStoredValue(CONNECTION_ID_STORAGE_KEY, window.sessionStorage)
  return cachedConnectionId
}

function getOrCreateStoredValue(key: string, storage: Storage): string {
  if (typeof window === "undefined") {
    return generateUUID()
  }

  try {
    const existing = storage.getItem(key)
    if (existing && existing.trim()) {
      return existing.trim()
    }
  } catch {
    return generateUUID()
  }

  const next = generateUUID()
  try {
    storage.setItem(key, next)
  } catch {
    // Ignore storage failures and fall back to the in-memory value.
  }
  return next
}

function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0
    const value = char === "x" ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}
