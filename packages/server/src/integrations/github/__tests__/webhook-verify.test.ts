import assert from "node:assert/strict"
import crypto from "node:crypto"
import { describe, it } from "node:test"

import { verifyGitHubWebhookSignature } from "../webhook-verify"

describe("verifyGitHubWebhookSignature", () => {
  it("accepts a valid sha256 signature", () => {
    const secret = "super-secret"
    const body = Buffer.from(JSON.stringify({ hello: "world" }), "utf-8")
    const expectedHex = crypto.createHmac("sha256", secret).update(body).digest("hex")
    assert.equal(verifyGitHubWebhookSignature({ secret, signatureHeader: `sha256=${expectedHex}`, body }), true)
  })

  it("rejects when secret is missing", () => {
    assert.equal(verifyGitHubWebhookSignature({ secret: " ", signatureHeader: "sha256=abcd", body: Buffer.from("{}") }), false)
  })

  it("rejects when signature header is missing or wrong prefix", () => {
    const secret = "s"
    const body = Buffer.from("{}")
    assert.equal(verifyGitHubWebhookSignature({ secret, signatureHeader: undefined, body }), false)
    assert.equal(verifyGitHubWebhookSignature({ secret, signatureHeader: "sha1=deadbeef", body }), false)
  })

  it("rejects when signature does not match", () => {
    assert.equal(verifyGitHubWebhookSignature({ secret: "super-secret", signatureHeader: "sha256=deadbeef", body: Buffer.from("{}") }), false)
  })
})
