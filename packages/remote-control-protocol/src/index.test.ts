import assert from "node:assert/strict"
import test from "node:test"
import { createClientHandshake, createHostHandshake, decodeBase64, encodeBase64 } from "./index"

test("binary relay payloads round-trip without truncation", () => {
  const input = Uint8Array.from({ length: 100_000 }, (_, index) => index % 251)
  assert.deepEqual(decodeBase64(encodeBase64(input)), input)
})

test("client and host establish authenticated directional encryption", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey)
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey)
  const client = await createClientHandshake(publicKey)
  const host = await createHostHandshake(privateKey)
  const accepted = await host.accept(client.hello)
  const clientChannel = await client.accept(accepted.ready)
  const plaintext = new TextEncoder().encode("opaque remote payload")

  const toHost = await clientChannel.encrypt(plaintext)
  assert.notDeepEqual(toHost, plaintext)
  assert.deepEqual(await accepted.channel.decrypt(toHost), plaintext)

  const toClient = await accepted.channel.encrypt(plaintext)
  assert.deepEqual(await clientChannel.decrypt(toClient), plaintext)
  await assert.rejects(() => clientChannel.decrypt(toClient), /replayed/)
})

test("encrypted frames fail closed after tampering", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair
  const client = await createClientHandshake(await crypto.subtle.exportKey("jwk", pair.publicKey))
  const host = await createHostHandshake(await crypto.subtle.exportKey("jwk", pair.privateKey))
  const accepted = await host.accept(client.hello)
  const clientChannel = await client.accept(accepted.ready)
  const frame = await clientChannel.encrypt(new TextEncoder().encode("secret"))
  frame[frame.length - 1] ^= 1
  await assert.rejects(() => accepted.channel.decrypt(frame), /authentication failed/)
})

test("host challenge prevents encrypted requests from being replayed into a new tunnel", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey)
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey)
  const client = await createClientHandshake(publicKey)
  const firstHost = await createHostHandshake(privateKey)
  const firstAccepted = await firstHost.accept(client.hello)
  const clientChannel = await client.accept(firstAccepted.ready)
  const captured = await clientChannel.encrypt(new TextEncoder().encode("state-changing request"))

  const secondHost = await createHostHandshake(privateKey)
  const secondAccepted = await secondHost.accept(client.hello)
  await assert.rejects(() => secondAccepted.channel.decrypt(captured), /authentication failed/)
})

test("client authenticates the host before establishing a channel", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair
  const client = await createClientHandshake(await crypto.subtle.exportKey("jwk", pair.publicKey))
  const host = await createHostHandshake(await crypto.subtle.exportKey("jwk", pair.privateKey))
  const accepted = await host.accept(client.hello)
  const ready = JSON.parse(accepted.ready) as { proof: string }
  const proof = decodeBase64(ready.proof)
  proof[proof.length - 1] ^= 1
  ready.proof = encodeBase64(proof)

  await assert.rejects(() => client.accept(JSON.stringify(ready)), /authentication failed/)
})
