export type MissionPreferenceKey = "missionModels" | "missionProfileDefaults"
export type MissionPreferenceExpectation = { key: MissionPreferenceKey; present: false } | { key: MissionPreferenceKey; present: true; value: unknown }

/** Snapshot raw values, including invalid documents and absence, for atomic owner CAS. */
export function missionPreferenceExpectation(owner: unknown, key: MissionPreferenceKey): MissionPreferenceExpectation {
  const settings = owner && typeof owner === "object" ? (owner as { settings?: unknown }).settings : undefined
  if (!settings || typeof settings !== "object" || !Object.prototype.hasOwnProperty.call(settings, key)) return { key, present: false }
  return { key, present: true, value: structuredClone((settings as Record<string, unknown>)[key]) }
}

export function missionPreferenceValue(owner: unknown, key: MissionPreferenceKey): unknown {
  const expectation = missionPreferenceExpectation(owner, key)
  return expectation.present ? expectation.value : undefined
}
