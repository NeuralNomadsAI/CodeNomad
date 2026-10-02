import assert from "node:assert/strict"
import test from "node:test"
import type { CredentialEntry } from "@opencode/client"
import { codexCredential } from "./codex-credential"

const token = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
const entry = (metadata: Record<string, any> = {}, claims: object = {}): CredentialEntry => ({
  id: "fixture", integrationID: "openai", label: "default", active: true, value: {
    type: "oauth", methodID: "chatgpt-browser", access: token(claims), refresh: "private-refresh",
    expires: Date.now() + 3600000, metadata: { accountID: "fixture-account", ...metadata },
  },
})
test("Codex login uses bounded email hints, never arbitrary token claims", () => {
  assert.equal(codexCredential(entry({ email: "native@example.com" }, { email: "jwt@example.com" }))?.login, "native@example.com")
  assert.equal(codexCredential(entry({}, { "https://api.openai.com/profile": { email: "profile@example.com" } }))?.login, "profile@example.com")
  for (const email of ["secret-access-token", "bad\n@example.com", "\x00@example.com", `${"x".repeat(255)}@example.com`]) {
    assert.equal(codexCredential(entry({ email }))?.login, undefined)
  }
  assert.equal(codexCredential(entry({}, { name: "Never disclose this" }))?.login, undefined)
})
test("expiry, integration and method remain hard credential boundaries", () => {
  const expired = entry(); expired.value = { ...expired.value, type: "oauth", methodID: "chatgpt-browser", access: "fixture", refresh: "fixture", expires: 1 }
  assert.equal(codexCredential(expired), null)
  assert.equal(codexCredential({ ...entry(), integrationID: "other" }), null)
  assert.equal(codexCredential(entry({}, { exp: 1 })), null)
  assert.equal(codexCredential({ ...entry(), value: { type: "key", key: "fixture" } }), null)
})
