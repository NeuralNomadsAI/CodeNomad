const KEEP_URL_KEYS = new Set(["html_url"])

function shouldDropKey(key: string): boolean {
  if (key === "installation") return true
  if (key === "url") return true
  if (key.endsWith("_url") && !KEEP_URL_KEYS.has(key)) return true
  return false
}

function sanitizeValue(value: any): any {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item))
  }
  if (!value || typeof value !== "object") {
    return value
  }

  const out: Record<string, any> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key === "body") {
      out[key] = raw
      continue
    }
    if (shouldDropKey(key)) {
      continue
    }
    out[key] = sanitizeValue(raw)
  }
  return out
}

export function sanitizeGitHubWebhookPayload(payload: unknown): unknown {
  let cloned: any
  try {
    cloned = JSON.parse(JSON.stringify(payload))
  } catch {
    cloned = payload as any
  }
  return sanitizeValue(cloned)
}
