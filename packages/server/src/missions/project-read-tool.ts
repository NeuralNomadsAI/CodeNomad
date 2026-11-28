import { z } from "zod"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { missionPanelPageRequestSchema } from "./mission-panel-page"

const schemas = { panel: missionPanelPageRequestSchema }
const sourceRead = z.object({ kind: z.literal("sources"), source: z.enum(["branches", "conversations", "coordinators", "repository"]),
    cursor: z.string().min(1).max(4096).optional(), search: z.string().max(200).optional() }).strict()
    .refine(value => ["conversations", "coordinators"].includes(value.source) || value.cursor === undefined && value.search === undefined)
const methods = { panel: "panelPage" } as const
const playbookRead = z.object({ kind: z.literal("playbook"),
  template: z.enum(["custom", "debug", "wayfinder", "delivery", "compare"]),
  taskMode: z.enum(["native", "independent"]).optional() }).strict()
export const projectReadWire = { oneOf: [
  ...Object.entries(methods).map(([kind, method]) => ({ type: "object", properties: {
    kind: { type: "string", const: kind }, input: CODENOMAD_MISSIONS_RPC.methods[method].input,
  }, required: ["kind", "input"], additionalProperties: false })),
  { type: "object", properties: { kind: { type: "string", const: "sources" },
    source: { type: "string", enum: ["branches", "conversations", "coordinators", "repository"] },
    cursor: { type: "string", minLength: 1, maxLength: 4096 }, search: { type: "string", maxLength: 200 } },
    required: ["kind", "source"], additionalProperties: false },
  { type: "object", properties: { kind: { type: "string", const: "playbook" },
    template: { type: "string", enum: ["custom", "debug", "wayfinder", "delivery", "compare"] },
    taskMode: { type: "string", enum: ["native", "independent"] } },
    required: ["kind", "template"], additionalProperties: false },
] }

export function parseProjectRead(input: unknown) {
  // Validate each method with its existing domain codec, retaining discriminated types.
  const value = z.object({ kind: z.string() }).passthrough().parse(input)
  if (value.kind === "sources") return sourceRead.parse(input)
  if (value.kind === "playbook") return playbookRead.parse(input)
  const kind = value.kind as keyof typeof schemas
  if (!Object.hasOwn(schemas, kind)) throw new Error("Unknown project Mission read")
  return { kind, input: schemas[kind].parse(z.object({ kind: z.string(), input: z.unknown() }).strict().parse(input).input) }
}
