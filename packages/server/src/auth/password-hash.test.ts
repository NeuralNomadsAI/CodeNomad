import assert from "node:assert/strict"
import crypto from "node:crypto"
import { it } from "node:test"
import { hashPassword, verifyPassword, type PasswordHashRecord } from "./password-hash"

it("produces the existing v1 scrypt format and unchanged default parameters", async () => {
  const password = "test-password"
  const record = await hashPassword(password)
  assert.equal(record.algorithm, "scrypt")
  assert.equal(Buffer.from(record.saltBase64, "base64").length, 16)
  assert.equal(record.keyLength, 64)
  assert.deepEqual(record.params, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 })
  const expected = crypto.scryptSync(password, Buffer.from(record.saltBase64, "base64"), record.keyLength, record.params)
  assert.equal(record.hashBase64, expected.toString("base64"))
  assert.equal(await verifyPassword(password, record), true)
  assert.equal(await verifyPassword("wrong-password", record), false)
})

it("verifies existing records using their saved salt, key length and custom scrypt parameters", async () => {
  const salt = Buffer.from("custom-salt")
  const params = { N: 1024, r: 8, p: 2, maxmem: 16 * 1024 * 1024 }
  const record: PasswordHashRecord = {
    algorithm: "scrypt", saltBase64: salt.toString("base64"),
    hashBase64: crypto.scryptSync("existing-password", salt, 32, params).toString("base64"),
    keyLength: 32, params,
  }
  assert.equal(await verifyPassword("existing-password", record), true)
  assert.equal(await verifyPassword("wrong-password", record), false)
  assert.equal(await verifyPassword("existing-password", { ...record, hashBase64: Buffer.from("short").toString("base64") }), false)
  assert.equal(await verifyPassword("existing-password", { ...record, algorithm: "unsupported" as "scrypt" }), false)
  await assert.rejects(verifyPassword("existing-password", { ...record, params: { ...params, N: 3 } }), /scrypt params/)
})
