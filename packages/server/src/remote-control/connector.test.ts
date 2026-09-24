import assert from "node:assert/strict"
import test from "node:test"
import { clientWebSocketCloseCode } from "@codenomad/remote-control-protocol"
import { WebSocket } from "undici"
import { normalizedRelayUrl } from "./connector"
import { allowedRemotePath, localHeaders, parseClientMessage, parseRelayMessage } from "./connector-protocol"

test("Remote Control relays require HTTPS except for loopback development", () => {
  assert.equal(normalizedRelayUrl("https://relay.example/path?ignored=1").href, "https://relay.example/")
  assert.equal(normalizedRelayUrl("http://127.0.0.1:8787").href, "http://127.0.0.1:8787/")
  assert.equal(normalizedRelayUrl("http://localhost:8787").href, "http://localhost:8787/")
  assert.throws(() => normalizedRelayUrl("http://relay.example"), /must use HTTPS/)
  assert.throws(() => normalizedRelayUrl("file:///relay"), /must use HTTPS/)
  for (const host of ["127.attacker.example", "127.0.0.1.attacker.example", "128.0.0.1"]) {
    assert.throws(() => normalizedRelayUrl(`http://${host}`), /must use HTTPS/)
  }
  assert.equal(normalizedRelayUrl("http://127.1.2.3:8787").hostname, "127.1.2.3")
  assert.equal(normalizedRelayUrl("http://[::1]:8787").hostname, "[::1]")
})

test("Remote Control replaces remote credentials and forwarding metadata with host-local identity", () => {
  const headers = localHeaders([
    ["authorization", "Bearer remote"],
    ["cookie", "remote=session"],
    ["origin", "https://remote.example"],
    ["content-length", "999"],
    ["cf-connecting-ip", "203.0.113.1"],
    ["x-real-ip", "203.0.113.2"],
    ["x-forwarded-host", "attacker.example"],
    ["x-codenomad-remote-control", "0"],
    ["content-type", "application/json"],
  ], "local=session")
  assert.equal(headers.get("authorization"), null)
  assert.equal(headers.get("origin"), null)
  assert.equal(headers.get("content-length"), null)
  assert.equal(headers.get("cf-connecting-ip"), null)
  assert.equal(headers.get("x-real-ip"), null)
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

test("Undici accepts normalized security and reconnect close codes", async () => {
  for (const code of [1002, 1003, 1008, 1009, 1012, 1013]) {
    const socket = new WebSocket("ws://127.0.0.1:1")
    const finished = new Promise<void>((resolve) => {
      socket.addEventListener("error", () => resolve(), { once: true })
      socket.addEventListener("close", () => resolve(), { once: true })
    })
    assert.doesNotThrow(() => socket.close(clientWebSocketCloseCode(code), "Security teardown"))
    await finished
  }
})

test("Remote Control accepts only bounded UUID-addressed tunnel contracts", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000"
  assert.ok(parseRelayMessage(JSON.stringify({ type: "tunnel.open", id })))
  assert.equal(parseRelayMessage(JSON.stringify({ type: "tunnel.open", id: "x".repeat(10_000) })), null)
  assert.ok(parseClientMessage(JSON.stringify({
    type: "http.request", id, method: "POST", path: "/api/items", headers: [["content-type", "application/json"]],
  })))
  assert.equal(parseClientMessage(JSON.stringify({
    type: "http.request", id, method: "POST", path: `/api/${"x".repeat(9_000)}`, headers: [],
  })), null)
  assert.equal(parseClientMessage(JSON.stringify({
    type: "http.request", id, method: "POST", path: "/api/items", headers: [["x-large", "x".repeat(17_000)]],
  })), null)
  assert.equal(parseClientMessage(JSON.stringify({
    type: "socket.open", id, path: "/api/socket", headers: [], protocols: Array.from({ length: 17 }, () => "v1"),
  })), null)
  assert.equal(parseClientMessage(JSON.stringify({
    type: "socket.open", id, path: "/api/socket", headers: [], protocols: ["v1", "v1"],
  })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: "socket.close", id, code: 1006 })), null)
})
