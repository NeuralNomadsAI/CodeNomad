import assert from "node:assert/strict"
import test from "node:test"
import { TokenManager } from "./token-manager"

test("concurrent native attachments receive independent one-shot bootstrap proofs", () => {
  const tokens = new TokenManager(60_000)
  const first = tokens.generate()
  const second = tokens.generate()
  assert.notEqual(first, second)
  assert.equal(tokens.consume(first), true)
  assert.equal(tokens.consume(first), false)
  assert.equal(tokens.consume(second), true)
  assert.equal(tokens.consume(second), false)
  assert.equal(tokens.consume("unknown"), false)
})

test("bootstrap quota refuses issuance without invalidating earlier proofs", () => {
  const tokens = new TokenManager(60_000)
  const proofs = Array.from({ length: 32 }, () => tokens.generate())
  assert.throws(() => tokens.generate(), /pending bootstrap/)
  assert.equal(tokens.consume(proofs[0]), true)
  const replacement = tokens.generate()
  assert.equal(tokens.consume(proofs[1]), true)
  assert.equal(tokens.consume(replacement), true)
})

test("expired proofs never authenticate and release their bounded slots", () => {
  const tokens = new TokenManager(-1)
  const expired = tokens.generate()
  assert.equal(tokens.consume(expired), false)
  for (let index = 0; index < 40; index++) tokens.generate()
})
