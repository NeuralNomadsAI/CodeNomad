import assert from "node:assert/strict"
import test from "node:test"
import type { RemoteServerProfile } from "../../../server/src/api-types"
import { resolveLaunchConnectTarget } from "./launch-connect-target"

const server = (id: string, name: string, baseUrl: string): RemoteServerProfile => ({
  id, name, baseUrl, skipTlsVerify: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
})
const prod = server("remote-prod", "Production", "https://prod.example.com")
const lab = server("remote-lab", "Lab box", "http://192.168.1.20:9898/")
const servers = [prod, lab]

test("saved servers resolve by id, then by name ignoring case and surrounding spaces", () => {
  assert.deepEqual(resolveLaunchConnectTarget("remote-lab", servers), { kind: "saved", server: lab })
  assert.deepEqual(resolveLaunchConnectTarget("Production", servers), { kind: "saved", server: prod })
  assert.deepEqual(resolveLaunchConnectTarget("  lab BOX ", servers), { kind: "saved", server: lab })
})

test("a URL reuses the saved server at that address, so its window storage and sign-in are kept", () => {
  assert.deepEqual(resolveLaunchConnectTarget("https://prod.example.com/", servers), { kind: "saved", server: prod })
  assert.deepEqual(resolveLaunchConnectTarget("http://192.168.1.20:9898", servers), { kind: "saved", server: lab })
})

test("an unsaved http(s) URL connects under its host name", () => {
  assert.deepEqual(resolveLaunchConnectTarget("https://new.example.com:8443", servers),
    { kind: "url", baseUrl: "https://new.example.com:8443/", name: "new.example.com:8443" })
})

test("missing, invalid, credential-carrying, unknown and ambiguous values are refused", () => {
  assert.deepEqual(resolveLaunchConnectTarget("  ", servers), { kind: "error", reason: "missing" })
  assert.deepEqual(resolveLaunchConnectTarget("ftp://prod.example.com", servers), { kind: "error", reason: "invalid" })
  assert.deepEqual(resolveLaunchConnectTarget("https://", servers), { kind: "error", reason: "invalid" })
  assert.deepEqual(resolveLaunchConnectTarget("https://user:secret@prod.example.com", servers), { kind: "error", reason: "credentials" })
  assert.deepEqual(resolveLaunchConnectTarget("https://prod.example.com/remote-pair#code", servers), { kind: "error", reason: "credentials" })
  assert.deepEqual(resolveLaunchConnectTarget("Staging", servers), { kind: "error", reason: "unknown" })
  assert.deepEqual(resolveLaunchConnectTarget("prod.example.com", servers), { kind: "error", reason: "unknown" })
  const twins = [server("a", "Build", "https://a.example.com"), server("b", "build", "https://b.example.com")]
  assert.deepEqual(resolveLaunchConnectTarget("BUILD", twins), { kind: "error", reason: "ambiguous" })
  assert.equal(resolveLaunchConnectTarget("Build", twins).kind, "saved", "an exact-case match settles a case-only clash")
})
