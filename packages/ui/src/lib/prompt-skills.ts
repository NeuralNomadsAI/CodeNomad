import type { SessionInboxUserPayload, SessionPromptInput } from "@opencode/client"
import type { Attachment } from "../types/attachment"

export function promptSkills(attachments: Attachment[], text: string, restored?: SessionInboxUserPayload): NonNullable<SessionPromptInput["skills"]> {
  const skills: Array<NonNullable<SessionPromptInput["skills"]>[number]> = []
  for (const { source } of attachments) {
    if (source.type !== "skill" || skills.some(skill => skill.id === source.id)) continue
    const original = restored?.skills?.find(skill => skill.id === source.id)?.mention
    const start = original ? text.indexOf(original.text) : -1
    const mention = original && start >= 0 ? { text: original.text, start, end: start + original.text.length } : undefined
    skills.push({ id: source.id, ...(mention ? { mention } : {}) })
  }
  return skills
}
