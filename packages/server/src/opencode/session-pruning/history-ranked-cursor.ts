import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

// Process-local authentication: continuations expire with their issuing backend/plugin.
// Bindings are digests so public tokens contain no native location paths.
const secret = randomBytes(32)
const digest = (binding: unknown) => createHash("sha256").update(JSON.stringify(binding)).digest("hex")
const sign = (body: string) => createHmac("sha256", secret).update(body).digest()

export class RankedHistoryRestartError extends Error {
  constructor() { super("Ranked history continuation expired or history changed"); this.name = "RankedHistoryRestartError" }
}

export function encodeRankedCursor(binding: unknown, value: unknown): string {
  const body = Buffer.from(JSON.stringify({ binding: digest(binding), value })).toString("base64url")
  return `${body}.${sign(body).toString("base64url")}`
}

export function decodeRankedCursor(binding: unknown, token: string): unknown {
  const [body, signature, extra] = token.split(".")
  const proof = Buffer.from(signature ?? "", "base64url")
  if (!body || extra !== undefined || proof.length !== 32 || proof.toString("base64url") !== signature
    || !timingSafeEqual(proof, sign(body))) throw new RankedHistoryRestartError()
  const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  if (decoded.binding !== digest(binding)) throw new RankedHistoryRestartError()
  return decoded.value
}
