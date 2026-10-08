import { createHmac, type KeyObject, verify } from "node:crypto"
import { z } from "zod"
import { authorityDigest, authoritySignerDigest, canonicalAuthority } from "./authority-protocol"
import type { FormAnswer } from "@opencode/client"
import type { Form } from "@opencode/schema/form"
import { nativeDecisionProvenance } from "./contracts"

export const HUMAN_ANSWER_HEADER = "x-codenomad-human-answer"
export const HUMAN_ANSWER_POLICY = "codenomad.missions.human-answer/signed-v1"
const id = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const location = z.object({ directory: z.string().min(1).max(4096), workspaceID: z.string().optional() }).strict()
const commonBinding = z.object({
  missionID: id, sessionID: id, formID: id, coordinatorSessionID: id,
  projectID: id, projectCanonical: z.string().min(1).max(4096), location,
  namespace: id, daemonStorageID: id,
  profileID: id, executionHost: id,
}).strict()
export const oneTimeHumanBindingSchema = commonBinding.extend({ mode: z.literal("one-time"),
  taskKey: id, generation: z.number().int().positive().safe(), nativeCall: nativeDecisionProvenance.shape.nativeCall }).strict()
export const recurringHumanBindingSchema = commonBinding.extend({ mode: z.literal("recurring"),
  scheduleID: id, passageID: id, grantID: id, epoch: z.number().int().positive().safe() }).strict()
const workspace = { workspaceID: z.string().min(1).max(200) }
const authentication = { ...workspace, cookieSessionID: z.string().min(1).max(256), username: z.string().min(1).max(256),
  answer: z.record(z.union([z.string().max(20000), z.array(z.string().max(20000)).max(32)])), issuedAt: z.number().int().nonnegative().safe() }
export const humanAnswerProofSchema = z.discriminatedUnion("mode", [oneTimeHumanBindingSchema.extend(authentication).strict(), recurringHumanBindingSchema.extend(authentication).strict()])
export type HumanAnswerProof = z.infer<typeof humanAnswerProofSchema>
export const humanAnswerRpcInputSchema = z.object({ body: humanAnswerProofSchema, proof: hash }).strict()
export const humanAnswerQuerySchema = z.discriminatedUnion("mode", [oneTimeHumanBindingSchema.extend(workspace).strict(), recurringHumanBindingSchema.extend(workspace).strict()])
export const humanAnswerResultSchema = z.object({ status: z.enum(["pending", "replied", "settled"]), identity: id }).strict()
export const humanAnswerBindingInputSchema = z.object({ sessionID: id, formID: id, profileID: id, executionHost: id }).strict()
export const humanAnswerBindingSchema = z.discriminatedUnion("mode", [oneTimeHumanBindingSchema, recurringHumanBindingSchema])
export const humanDecisionRequestSchema = nativeDecisionProvenance.extend({ question: z.string().min(1).max(20000),
  answer: z.union([z.string().min(1).max(20000), z.array(z.string().min(1).max(20000)).min(1).max(32)]),
  projectID: id, directory: z.string().min(1).max(4096), delegationToolName: z.enum(["subagent", "task"]) }).strict()
export const HUMAN_ANSWER_RPC = { id: "codenomad.missions.human-answer", methods: {
  binding: { input: humanAnswerBindingInputSchema, output: humanAnswerBindingSchema.nullable() },
  reply: { input: humanAnswerRpcInputSchema, output: humanAnswerResultSchema },
  reconcile: { input: humanAnswerQuerySchema, output: humanAnswerResultSchema },
  verify: { input: humanDecisionRequestSchema, output: z.unknown() },
}, events: {} }
export function humanAnswerProof(body: HumanAnswerProof, secret: string): string {
  return createHmac("sha256", secret).update(canonicalAuthority(body)).digest("hex")
}
export function assertHumanAnswerFresh(body: HumanAnswerProof, now = Date.now()): void {
  if (body.cookieSessionID === "auth-disabled" || body.issuedAt > now + 5000 || now - body.issuedAt >= 30000)
    throw new Error("Human answer authentication expired")
}
export function humanAnswerIdentity(binding: unknown): string {
  const { workspaceID: _, ...native } = humanAnswerQuerySchema.parse(binding)
  return `hanswer_${authorityDigest(native).slice(0, 48)}`
}
export function humanAnswerSigningBytes(body: unknown): Buffer { return Buffer.from(`${HUMAN_ANSWER_POLICY}\n${canonicalAuthority(body, 256 * 1024)}`) }

export interface HumanAnswerReservation {
  version: 1; identity: string; binding: z.infer<typeof humanAnswerQuerySchema>
  principal: { kind: "codenomad-human"; sessionDigest: string; username: string }
  form: Form.Info; answer: FormAnswer; messageID: string; toolCallID: string
  called: { id: string; seq: number }; signerDigest: string
  state: "reserved" | "replied" | "settled"
  answered?: { id: string; seq: number }; signature: string
}
export function verifyHumanAnswerSignature(record: HumanAnswerReservation, publicKey: KeyObject): void {
  const { signature, ...body } = record
  if (publicKey.asymmetricKeyType !== "ed25519" || record.signerDigest !== authoritySignerDigest(publicKey)
    || !verify(null, humanAnswerSigningBytes(body), publicKey, Buffer.from(signature, "base64")))
    throw new Error("Human answer receipt signature mismatch")
}
export type NativeHumanAnswerGate = (request: import("./native-human-evidence").NativeDecisionEvidenceRequest) => Promise<HumanAnswerReservation>

/** The Form and durable question INPUT must be the same exact native call.
 * Descriptions and free text are preserved, not projected or normalised. */
export function matchHumanQuestion(form: Form.Info, input: Record<string, unknown>, answer: FormAnswer): string[][] {
  canonicalAuthority({ form, input, answer }, 128 * 1024)
  const questions = input.questions
  if (form.metadata?.kind !== "question" || !Array.isArray(questions) || !questions.length || questions.length > 32
    || form.fields.length !== questions.length || Object.keys(answer).some(key => !form.fields.some(field => field.key === key)))
    throw new Error("Native question schema mismatch")
  return questions.map((question, index) => {
    const field = form.fields[index], value = answer[`q${index}`]
    const q = z.object({ question: z.string(), header: z.string(), multiple: z.boolean().optional(),
      options: z.array(z.object({ label: z.string(), description: z.string() })).max(32) }).parse(question)
    const expected = { key: `q${index}`, title: q.header, description: q.question,
      type: q.multiple === true ? "multiselect" : "string", custom: true,
      options: q.options.map(option => ({ value: option.label, ...option })) }
    if (canonicalAuthority(field) !== canonicalAuthority(expected) || value !== undefined && (q.multiple === true
      ? !Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== "string") : typeof value !== "string"))
      throw new Error("Native question answer mismatch")
    return value === undefined ? [] : Array.isArray(value) ? [...value] : [value as string]
  })
}
