import { z } from "zod"

// The loaded-only RPC and individual native Form reader consume the same fields.
const numeric = z.union([z.number(), z.enum(["Infinity", "-Infinity", "NaN"])])
const option = z.object({ value: z.string(), label: z.string(), description: z.string().optional() })
const field = z.object({
  key: z.string(), title: z.string().optional(), description: z.string().optional(),
  required: z.boolean().optional(), hidden: z.boolean().optional(),
  when: z.array(z.object({ key: z.string(), op: z.enum(["eq", "neq"]), value: z.union([z.string(), numeric, z.boolean()]) })).optional(),
})
const fieldSchema = z.discriminatedUnion("type", [
  field.extend({ type: z.literal("string"), format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    minLength: z.number().optional(), maxLength: z.number().optional(), pattern: z.string().optional(),
    placeholder: z.string().optional(), default: z.string().optional(), options: z.array(option).optional(), custom: z.boolean().optional() }),
  field.extend({ type: z.literal("number"), minimum: numeric.optional(), maximum: numeric.optional(), default: numeric.optional() }),
  field.extend({ type: z.literal("integer"), minimum: numeric.optional(), maximum: numeric.optional(), default: numeric.optional() }),
  field.extend({ type: z.literal("boolean"), default: z.boolean().optional() }),
  field.extend({ type: z.literal("multiselect"), options: z.array(option), minItems: z.number().optional(),
    maxItems: z.number().optional(), custom: z.boolean().optional(), default: z.array(z.string()).optional() }),
  field.extend({ type: z.literal("external"), url: z.string() }),
])
export const formInfoSchema = z.object({
  id: z.string(), sessionID: z.string(), title: z.string(), metadata: z.record(z.unknown()).optional(),
  fields: z.array(fieldSchema).min(1),
})
const answer = z.record(z.union([z.string(), numeric, z.boolean(), z.array(z.string())]))
export const wireFormSchema = formInfoSchema.extend({ state: z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("answered"), answer }),
  z.object({ status: z.literal("cancelled"), message: z.string().optional() }),
]) }).superRefine((form, context) => {
  for (const field of form.fields) for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    const value = key in field ? (field as unknown as Record<string, unknown>)[key] : undefined
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) context.addIssue({ code: "custom", message: "Invalid Form count" })
  }
})

/** Only this projection crosses the verified reader boundary; answers remain transient. */
export const verifiedFormSchema = formInfoSchema.extend({ state: z.object({ status: z.enum(["pending", "answered", "cancelled"]) }) })
export type VerifiedForm = z.infer<typeof verifiedFormSchema>
