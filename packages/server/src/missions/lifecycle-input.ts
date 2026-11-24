import type { RecurrenceConfig } from "./recurrence-contract"

/** Existing finite native lifecycle receipt text ceiling (UTF-16 characters). */
export const MISSION_LIFECYCLE_TEXT_LIMIT = 16_384

/** Exact frozen synthetic payload. Playbook context is supplied separately by
 * MissionControl's actor context, not appended to this receipt-owned text. */
export function recurrenceStartText(config: Pick<RecurrenceConfig, "consigne" | "template" | "taskMode">): string {
  const text = config.consigne
  if (!text.length || text.length > MISSION_LIFECYCLE_TEXT_LIMIT) throw new Error("Recurrence start text exceeds lifecycle capacity")
  return text
}
