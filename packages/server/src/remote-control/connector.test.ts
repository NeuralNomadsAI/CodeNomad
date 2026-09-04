import assert from "node:assert/strict"
import test from "node:test"
import { normalizedRelayUrl } from "./connector"
import { allowedRemotePath, localHeaders } from "./connector-protocol"

test("Remote Control relays require HTTPS except for loopback development", () => {
  assert.equal(normalizedRelayUrl("https://relay.example/path?ignored=1").href, "https://relay.example/")
  assert.equal(normalizedRelayUrl("http://127.0.0.1:8787").href, "http://127.0.0.1:8787/")
  assert.equal(normalizedRelayUrl("http://localhost:8787").href, "http://localhost:8787/")
  assert.throws(() => normalizedRelayUrl("http://relay.example"), /must use HTTPS/)
  assert.throws(() => normalizedRelayUrl("file:///relay"), /must use HTTPS/)
})

test("Remote Control replaces remote credentials and forwarding metadata with host-local identity", () => {
  const headers = localHeaders([
    ["authorization", "Bearer remote"],
    ["cookie", "remote=session"],
    ["origin", "https://remote.example"],
    ["x-forwarded-host", "attacker.example"],
    ["x-codenomad-remote-control", "0"],
    ["content-type", "application/json"],
  ], "local=session")
  assert.equal(headers.get("authorization"), null)
  assert.equal(headers.get("origin"), null)
  assert.equal(headers.get("x-forwarded-host"), null)
  assert.equal(headers.get("cookie"), "local=session")
  assert.equal(headers.get("x-codenomad-remote-control"), "1")
  assert.equal(headers.get("content-type"), "application/json")
})

test("Remote Control reaches only API and workspace namespaces", () => {
  assert.equal(allowedRemotePath("/api/events"), true)
  assert.equal(allowedRemotePath("/workspaces/example/instance/api/session"), true)
  assert.equal(allowedRemotePath("/api"), false)
  assert.equal(allowedRemotePath("/assets/app.js"), false)
  assert.equal(allowedRemotePath("//attacker.example/api/events"), false)
})
