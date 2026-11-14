import { z } from "zod"

export const MISSION_MIN_INTERVAL_MS = 15 * 60_000
export const documentCounter = z.number().int().nonnegative().safe()
export const documentTimestamp = documentCounter.max(Date.parse("9999-12-28T00:00:00Z"))
