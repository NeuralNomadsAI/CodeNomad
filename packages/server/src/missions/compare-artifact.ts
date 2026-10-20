import { z } from "zod"
import type { MissionJsonValue, MissionTask } from "./model"

const text = z.string().min(1).max(20_000)
const ref = z.string().min(1).max(64)
const nativeID = z.string().min(1).max(240).regex(/^[^\s\x00-\x1f\x7f]+$/)
const evidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native"), sessionID: nativeID, messageID: nativeID, partID: nativeID }).strict(),
  z.object({ kind: z.literal("file"), path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
])
export const compareArtifact = z.object({ version: z.literal(1), kind: z.literal("comparison"),
  runRefs: z.tuple([ref, ref]), verdict: z.enum(["a", "b", "equivalent", "inconclusive"]),
  results: z.array(z.object({ criterion: ref, a: z.number().min(0).max(10), b: z.number().min(0).max(10),
    observation: text, evidence: z.array(evidence).min(1).max(32) }).strict()).min(1).max(32),
}).strict()

export function validateCompareArtifact(artifact: MissionJsonValue | undefined, tasks: readonly MissionTask[]): MissionJsonValue {
  const value = compareArtifact.parse(artifact)
  if (JSON.stringify(value).length >= 50_000) throw new Error("Compare artifact must be smaller than 50000 characters")
  if (new Set(value.results.map(item => item.criterion)).size !== value.results.length) throw new Error("Comparison criteria must be unique")
  for (const [index, role] of ["model-a", "model-b"].entries()) {
    if (!tasks.some(task => task.key === value.runRefs[index] && task.role === role && task.status === "completed"
      && !task.replacedByTaskKey && task.report?.outcome === "completed" && !task.report.late)) {
      throw new Error("Comparison requires the completed model-a and model-b reports, in that order")
    }
  }
  return value
}

export function comparisonText(value: z.infer<typeof compareArtifact>): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ")
  return "| | A | B |\n|---|---|---|\n" + value.results.map(item => `| ${cell(item.criterion)} | ${item.a} | ${item.b} |`).join("\n")
    + "\n\n" + value.results.map(item => `${item.criterion}: ${item.observation}\n\n${item.evidence.map(ref => {
      const label = ref.kind === "file" ? ref.path : `${ref.messageID.slice(0, 20)}/${ref.partID.slice(0, 20)}`
      return `- ${label.replace(/[\\\`*_[\]<>]/g, "\\$&")}`
    }).join("\n")}`).join("\n\n")
}
