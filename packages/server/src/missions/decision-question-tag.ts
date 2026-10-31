import { stableToken } from "./receipt-identity"

/** The exact decision task a coordinator question answers, written at the end of the question
 * the human reads: the task key in clear and a code bound to its mission. */
export function decisionQuestionTag(missionID: string, taskKey: string): string {
  return `[decision ${taskKey} ${stableToken(`decision-question\0${missionID}\0${taskKey}`, 8)}]`
}

const DECISION_TAG = /\[decision [a-z0-9][a-z0-9._-]{1,63} [0-9a-f]{8}\]/g

/** The one decision a coordinator question field binds, from the text the coordinator wrote for that
 * field alone: its question (the Form field description) must end with a decision tag, and neither its
 * question nor its header (the field title) may hold any other tag. A field quoting a second decision
 * binds none; options and the human's answer never bind. Shared by MissionControl, the native gate and
 * discovery, so each field of a batched question binds independently. */
export function fieldDecisionTag(field: { description?: unknown; title?: unknown }): string | undefined {
  const question = typeof field.description === "string" ? field.description : ""
  const header = typeof field.title === "string" ? field.title : ""
  const tags = new Set([...`${header}\n${question}`.matchAll(DECISION_TAG)].map(match => match[0]))
  if (tags.size !== 1) return undefined
  const [tag] = tags
  return question.trimEnd().endsWith(tag) ? tag : undefined
}
