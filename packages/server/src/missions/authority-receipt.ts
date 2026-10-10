import { z } from "zod"
import { authorityIntentSchema, authorityEffectResultSchema, matchesAuthorityCompletion, AUTHORITY_ID_MAX_LENGTH, AUTHORITY_REQUEST_MAX_LENGTH } from "./authority-protocol"

/** Exact public signed-business input, never a signature/key or caller identity.
 * No list/cursor, storage key, caller RPC name or mutation is accepted. */
export const authorityReceiptQuerySchema = z.object({
  intent: authorityIntentSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type AuthorityReceiptQuery = z.infer<typeof authorityReceiptQuerySchema>

/** Wire projection of one existing native receipt, not another storage schema
 * or receipt engine. Keep outcomes/provenance and absent completion truthful. */
export const authorityReceiptReadSchema = z.object({
  namespace: z.string().uuid(), projectID: z.string().min(1).max(AUTHORITY_ID_MAX_LENGTH),
  projectCanonical: z.string().min(1).max(4096),
  receipt: z.object({
    requestID: z.string().min(1).max(AUTHORITY_REQUEST_MAX_LENGTH), digest: z.string().regex(/^[a-f0-9]{64}$/),
    signerDigest: z.string().regex(/^[a-f0-9]{64}$/), provisioningGeneration: z.string().min(1).max(AUTHORITY_ID_MAX_LENGTH),
    intent: authorityIntentSchema,
    completion: z.object({ outcome: z.enum(["applied", "rejected"]),
      result: z.union([authorityEffectResultSchema, z.object({ metadataOnly: z.literal(true) }).strict()]),
    }).strict().optional(),
  }).strict().superRefine((receipt, context) => {
    if (receipt.completion && !matchesAuthorityCompletion(receipt.intent, receipt.completion)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["completion", "result"], message: "Completion does not match its intent" })
    }
  }).nullable(),
}).strict()
export type AuthorityReceiptRead = z.infer<typeof authorityReceiptReadSchema>
