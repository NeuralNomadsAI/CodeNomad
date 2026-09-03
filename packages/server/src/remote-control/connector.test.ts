import assert from "node:assert/strict"
import test from "node:test"
import { normalizedRelayUrl } from "./connector"

test("Remote Control relays require HTTPS except for loopback development", () => {
  assert.equal(normalizedRelayUrl("https://relay.example/path?ignored=1").href, "https://relay.example/")
  assert.equal(normalizedRelayUrl("http://127.0.0.1:8787").href, "http://127.0.0.1:8787/")
  assert.equal(normalizedRelayUrl("http://localhost:8787").href, "http://localhost:8787/")
  assert.throws(() => normalizedRelayUrl("http://relay.example"), /must use HTTPS/)
  assert.throws(() => normalizedRelayUrl("file:///relay"), /must use HTTPS/)
})
