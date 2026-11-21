export const BROWSER_DISCOVERY_TIMEOUT_MS = 5_000

export function isBrowserTarget(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value)
}

export function browserTargetRefusal(message: string): { code: string; error: string } {
  if (message.includes("Multiple visible browser targets exist for this session")) {
    return { code: "ambiguous-target", error: "Several visible previews match this session" }
  }
  if (/no visible (?:local )?browser target/i.test(message)) {
    return { code: "hidden-preview", error: "Show the session preview and take a new snapshot" }
  }
  if (/target (?:changed|is stale|is no longer current)|document changed|lease is no longer current/i.test(message)) {
    return { code: "stale-preview", error: "The preview changed; take a new snapshot" }
  }
  return { code: "browser-unavailable", error: message }
}
