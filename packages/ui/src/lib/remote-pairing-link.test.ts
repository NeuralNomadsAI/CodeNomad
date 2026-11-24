import assert from "node:assert/strict"
import test from "node:test"
import { splitPairingLink } from "./remote-pairing-link"

test("a pairing link yields the server origin and a single-use entry", () => {
  assert.deepEqual(splitPairingLink("  https://codenomad-1a2b.abc.opentunnel.xyz/remote-pair#Code_123-x  "), {
    baseUrl: "https://codenomad-1a2b.abc.opentunnel.xyz",
    entryUrl: "https://codenomad-1a2b.abc.opentunnel.xyz/remote-pair#Code_123-x",
  })
})

test("a query string never travels into the window entry", () => {
  assert.equal(splitPairingLink("https://host.example/remote-pair?x=1#code")?.entryUrl, "https://host.example/remote-pair#code")
})

test("ordinary server addresses and incomplete links are not pairing links", () => {
  for (const input of [
    "https://host.example",
    "https://host.example/#code",
    "https://host.example/remote-pair",
    "https://host.example/remote-pair#",
    "http://host.example/remote-pair#code",
    "not a url",
  ]) {
    assert.equal(splitPairingLink(input), null, input)
  }
})
