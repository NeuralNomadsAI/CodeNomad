import { createHmac } from "node:crypto"
import { z } from "zod"
import { canonicalAuthority } from "./authority-protocol"
import type { FormAnswer } from "@opencode/client"
import type { Form } from "@opencode/schema/form"
import { nativeDecisionProvenance } from "./contracts"

export const HUMAN_ANSWER_HEADER = "x-codenomad-human-answer"
/** Simple UI-answer marks; independent of the retired `authority-v2` namespace. */
export const HUMAN_MARK_STORAGE_PREFIX = "codenomad-missions/human-marks-v1"
const id = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/)
const location = z.object({ directory: z.string().min(1).max(4096), workspaceID: z.string().optional() }).strict()
export const humanAnswerBindingSchema = z.object({ sessionID: id, formID: id,
  projectID: id, location, profileID: id, executionHost: id }).strict()
export const humanAnswerProofSchema = humanAnswerBindingSchema.extend({ workspaceID: z.string().min(1).max(200),
  cookieSessionID: z.string().min(1).max(256), username: z.string().min(1).max(256),
  answer: z.record(z.union([z.string().max(20000), z.array(z.string().max(20000)).max(32)])),
  issuedAt: z.number().int().nonnegative().safe() }).strict()
export type HumanAnswerProof = z.infer<typeof humanAnswerProofSchema>
export const humanAnswerRpcInputSchema = z.object({ body: humanAnswerProofSchema, proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const humanAnswerResultSchema = z.object({ status: z.literal("answered") }).strict()
export const humanAnswerBindingInputSchema = z.object({ sessionID: id, formID: id, profileID: id, executionHost: id }).strict()
export const humanDecisionRequestSchema = nativeDecisionProvenance.extend({ question: z.string().min(1).max(20000),
  answer: z.union([z.string().min(1).max(20000), z.array(z.string().min(1).max(20000)).min(1).max(32)]),
  projectID: id, directory: z.string().min(1).max(4096), delegationToolName: z.enum(["subagent", "task"]),
  /** Required when no binding was published: the fresh delegation call's prompt must carry this exact assignment. */
  assignmentPrompt: z.string().min(1).max(128 * 1024).optional() }).strict()
export const HUMAN_ANSWER_RPC = { id: "codenomad.missions.human-answer", methods: {
  binding: { input: humanAnswerBindingInputSchema, output: humanAnswerBindingSchema.nullable() },
  reply: { input: humanAnswerRpcInputSchema, output: humanAnswerResultSchema },
  verify: { input: humanDecisionRequestSchema, output: z.unknown() },
}, events: {} }
export function humanAnswerProof(body: HumanAnswerProof, secret: string): string {
  return createHmac("sha256", secret).update(canonicalAuthority(body)).digest("hex")
}
export function assertHumanAnswerFresh(body: HumanAnswerProof, now = Date.now()): void {
  if (body.cookieSessionID === "auth-disabled" || body.issuedAt > now + 5000 || now - body.issuedAt >= 30000)
    throw new Error("Human answer authentication expired")
}

/** UI provenance only. The snapshot retains exact field keys/descriptions and
 * submitted answers after the native Form cache expires; no auth secrets.
 * acquireNativeHumanAnswers(ctx).verify(request) returns this after checking the
 * answered native question and exact Form/session/message/tool bindings. */
export interface HumanDecisionMark {
  formID: string; sessionID: string; answeredAt: number; via: "ui"
  form: Form.Info; answer: FormAnswer
}
export type NativeHumanAnswerGate = (request: import("./native-human-evidence").NativeDecisionEvidenceRequest) => Promise<HumanDecisionMark>

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
