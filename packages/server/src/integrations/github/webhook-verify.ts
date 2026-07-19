import { createHmac, timingSafeEqual } from "crypto"

export function verifyGitHubWebhookSignature(params: {
  secret: string
  signatureHeader?: string
  body: Buffer
}): boolean {
  const secret = (params.secret ?? "").trim()
  const header = (params.signatureHeader ?? "").trim()
  if (!secret || !header || !header.startsWith("sha256=")) return false

  const expected = `sha256=${createHmac("sha256", secret).update(params.body).digest("hex")}`
  const expectedBuffer = Buffer.from(expected, "utf8")
  const providedBuffer = Buffer.from(header, "utf8")
  if (expectedBuffer.length !== providedBuffer.length) return false
  return timingSafeEqual(expectedBuffer, providedBuffer)
}
