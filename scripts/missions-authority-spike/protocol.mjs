// Private spike wire contract. No environment values or private key enter the plugin.
import { createHash, sign, verify } from "node:crypto"

export const POLICY = "missions-authority-spike/signed-v1"
export const RPC = {
  id: "missions.authority.spike",
  methods: {
    challenge: { input: { type: "object" }, output: { type: "object" } },
    privileged: { input: { type: "object" }, output: { type: "object" }, errors: {
      "mission.rejected": { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    } },
  }, events: {},
}

export function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  throw new Error("Non-portable authority payload")
}
export const digest = value => createHash("sha256").update(canonical(value)).digest("hex")
const bytes = body => Buffer.from(`${POLICY}\n${canonical(body)}`)
export const envelope = (body, privateKey) => ({ body, signature: sign(null, bytes(body), privateKey).toString("base64") })

export function authenticate(input, publicKey) {
  if (!input || Object.keys(input).sort().join(",") !== "body,signature" || typeof input.signature !== "string"
    || input.signature.length > 256 || !verify(null, bytes(input.body), publicKey, Buffer.from(input.signature, "base64"))) {
    throw new Error("Authority signature rejected")
  }
  const body = input.body
  const fields = "authorityID,epoch,executionHost,expectedRevision,method,missionID,namespace,payload,profileID,projectCanonical,projectID,requestID,roots,version"
  if (!body || Object.keys(body).sort().join(",") !== fields || body.version !== 1
    || !Number.isSafeInteger(body.epoch) || body.epoch < 1
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0
    || !["create", "adopt", "revoke", "lifecycle", "invoke", "capture", "invoke-captured"].includes(body.method)
    || ![body.authorityID, body.profileID, body.executionHost, body.namespace, body.projectID, body.projectCanonical, body.requestID].every(s => typeof s === "string" && s.length > 0 && s.length < 4096)
    || !Array.isArray(body.roots) || body.roots.length !== 1 || typeof body.roots[0] !== "string") throw new Error("Authority envelope rejected")
  return body
}
