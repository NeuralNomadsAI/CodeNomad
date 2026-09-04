import assert from "node:assert/strict"
import test from "node:test"
import { DEVICE_COOKIE, bearerToken, clearDeviceCookie, cookieToken, deviceCookie, tokenHash } from "./security"

test("host bearer tokens are read only from the authorization header", () => {
  assert.equal(bearerToken(new Request("https://relay.example/?secret=query", { headers: { Authorization: "Bearer host-secret" } })), "host-secret")
  assert.equal(bearerToken(new Request("https://relay.example/?secret=query")), null)
})

test("device credentials use secure host-scoped cookies", () => {
  const cookie = deviceCookie("device token", 60)
  assert.match(cookie, new RegExp(`^${DEVICE_COOKIE}=`))
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=60/)
  assert.equal(cookieToken(new Request("https://host.relay.example", { headers: { Cookie: cookie } })), "device token")
  assert.match(clearDeviceCookie(), /Max-Age=0/)
  assert.equal(cookieToken(new Request("https://host.relay.example", { headers: { Cookie: `${DEVICE_COOKIE}=%GG` } })), null)
})

test("stored credentials are deterministic hashes rather than raw tokens", async () => {
  const hash = await tokenHash("secret")
  assert.match(hash, /^[a-f0-9]{64}$/)
  assert.equal(hash, await tokenHash("secret"))
  assert.notEqual(hash, "secret")
})
