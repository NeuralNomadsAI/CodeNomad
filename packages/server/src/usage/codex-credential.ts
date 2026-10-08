import { createHash } from "node:crypto"
import type { CredentialEntry } from "@opencode/client"
import { decodeJwtClaims, getString } from "./shared"

// Server-only. This object must never be logged, cached or returned over HTTP.
export function codexCredential(entry: CredentialEntry, now = Date.now()) {
  const value = entry.value
  if (entry.integrationID !== "openai" || value.type !== "oauth"
    || !["chatgpt-browser", "chatgpt-headless"].includes(value.methodID)
    || !Number.isFinite(value.expires) || value.expires <= now + 120_000 || !getString(value.access)) return null
  const claims = decodeJwtClaims(value.access)
  const expiry = Number(claims?.exp) * 1000
  if (Number.isFinite(expiry) && expiry <= now + 120_000) return null
  const accountID = getString(value.metadata?.accountID)
    ?? getString(claims?.["https://api.openai.com/auth"]?.chatgpt_account_id)
  if (!accountID) return null
  const identity = createHash("sha256").update(JSON.stringify([
    entry.integrationID, entry.id, value.methodID, accountID, value.expires, value.access,
  ])).digest("hex")
  const email = getString(value.metadata?.email)
    ?? getString(claims?.["https://api.openai.com/profile"]?.email) ?? getString(claims?.email)
  // Display only, not authentication or authorization. Do not return arbitrary claims.
  const login = email && email.length <= 254 && /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(email) ? email : undefined
  return { identity, access: value.access, accountID, login }
}
