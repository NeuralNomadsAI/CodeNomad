// prototype-1236: fixed error codes of read-only Files/Changes reads on an explicit OpenCode server.
const INCOMPLETE = new Set(["ambiguous", "unavailable", "too_large", "not_found", "invalid_path"])

/** The user's-language text for a remote read code; any other message is returned unchanged. */
export function remoteReadErrorText(message: string, t: (key: string) => string): string {
  if (message === "not_repository") return t("filesPanel.gitInit.notRepository")
  return INCOMPLETE.has(message) ? t("filesPanel.contentUnavailable") : message
}
