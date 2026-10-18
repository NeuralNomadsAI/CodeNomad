/**
 * One routing table for every CodeNomad notification. Each notification declares
 * a category; Settings → Notifications chooses, per category, whether it appears
 * on screen (temporary bubble), in the history (which also feeds the icon badge)
 * and as a system notification.
 */
export const NOTIFICATION_CATEGORIES = [
  "needsInput", "sessionDone", "updates", "files", "projects", "sessions", "opencode", "copy", "settings",
] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export const NOTIFICATION_DESTINATIONS = ["screen", "history", "system"] as const
export type NotificationDestination = (typeof NOTIFICATION_DESTINATIONS)[number]

export type NotificationRoute = Record<NotificationDestination, boolean>
export type NotificationRouting = Record<NotificationCategory, NotificationRoute>

const route = (screen: boolean, history: boolean, system: boolean): NotificationRoute => ({ screen, history, system })

/** Defaults keep the history (and badge) for what needs attention, not routine feedback. */
export const defaultNotificationRouting: NotificationRouting = {
  needsInput: route(false, true, true),
  sessionDone: route(false, true, true),
  updates: route(true, true, true),
  files: route(true, true, false),
  projects: route(true, true, false),
  sessions: route(true, false, false),
  opencode: route(true, true, false),
  copy: route(true, false, false),
  settings: route(true, false, false),
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

/**
 * Unknown categories/destinations are dropped and missing ones use defaults.
 * Until routing is first saved, saved former system settings keep their meaning:
 * an explicitly disabled system switch leaves the whole system column off, and
 * the per-event toggles still apply to the two session events. A switch that was
 * never saved takes the new defaults (a product decision: upgrades get the same
 * System column as new installations, although the old switch defaulted to off).
 */
export function normalizeNotificationRouting(
  value: unknown,
  legacy?: { osNotificationsEnabled?: boolean; notifyOnNeedsInput?: boolean; notifyOnIdle?: boolean },
): NotificationRouting {
  const source = isRecord(value) ? value : undefined
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => {
    const fallback = { ...defaultNotificationRouting[category] }
    if (!source && legacy?.osNotificationsEnabled === false) fallback.system = false
    if (!source && category === "needsInput" && legacy?.notifyOnNeedsInput === false) fallback.system = false
    if (!source && category === "sessionDone" && legacy?.notifyOnIdle === false) fallback.system = false
    const saved = isRecord(source?.[category]) ? source![category] as Record<string, unknown> : {}
    return [category, Object.fromEntries(NOTIFICATION_DESTINATIONS.map((destination) =>
      [destination, typeof saved[destination] === "boolean" ? saved[destination] : fallback[destination]]))]
  })) as NotificationRouting
}

/** Where one notification goes. An error always reaches the screen and the history, so a failure is never lost. */
export function notificationTargets(
  routing: NotificationRouting | undefined,
  category: NotificationCategory,
  variant: string,
): NotificationRoute {
  const selected = (routing ?? defaultNotificationRouting)[category] ?? defaultNotificationRouting[category]
  const error = variant === "error"
  return { screen: selected.screen || error, history: selected.history || error, system: selected.system }
}
