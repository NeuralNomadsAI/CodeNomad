import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { canonicalAuthority } from "./authority-protocol"
import { assertRecurrenceProofFresh } from "./recurrence-control-proof"
import { projectToolCommand, projectToolCommandWire } from "./project-control-tool"

export const projectControlProof = z.object({
  principal: z.object({ kind: z.literal("agent"), sessionID: z.string().regex(/^ses/).max(240) }).strict(),
  projectID: z.string().min(1).max(240), directory: z.string().min(1).max(4096),
  command: projectToolCommand, issuedAt: z.number().int().nonnegative().safe(), proof: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type ProjectControlProof = z.infer<typeof projectControlProof>
export function signProjectControl(value: Omit<ProjectControlProof, "proof">, token: string) {
  return createHmac("sha256", token).update(canonicalAuthority(value, 512 * 1024)).digest("hex")
}
export function verifyProjectControl(raw: unknown, token: string) {
  const { proof, ...value } = projectControlProof.parse(raw)
  assertRecurrenceProofFresh(value.issuedAt)
  if (!timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(signProjectControl(value, token), "hex")))
    throw new Error("Mission agent principal differs")
  return value
}
export const projectControlProofWire = { type: "object", properties: {
  principal: { type: "object", properties: { kind: { const: "agent" }, sessionID: { type: "string", minLength: 1, maxLength: 240 } },
    required: ["kind", "sessionID"], additionalProperties: false },
  projectID: { type: "string", minLength: 1, maxLength: 240 }, directory: { type: "string", minLength: 1, maxLength: 4096 },
  command: projectToolCommandWire, issuedAt: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  proof: { type: "string", minLength: 64, maxLength: 64 },
}, required: ["principal", "projectID", "directory", "command", "issuedAt", "proof"], additionalProperties: false } as const
