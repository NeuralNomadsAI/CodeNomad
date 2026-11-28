/** Reserved ordinary-input namespace; durable mappings establish membership. */
export const MISSION_SCHEDULE_CARRIER_SESSION_PREFIX = "ses_cn_schedule_"
export const MISSION_GOAL_CARRIER_SESSION_PREFIX = "ses_cn_goal_"
export const isReservedMissionScheduleSessionID = (id: string): boolean =>
  id.startsWith(MISSION_SCHEDULE_CARRIER_SESSION_PREFIX) || id.startsWith(MISSION_GOAL_CARRIER_SESSION_PREFIX)
