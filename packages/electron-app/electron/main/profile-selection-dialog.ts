import type { TransitionCandidate } from "./profile-transition"

/**
 * Text of the one-time profile question, shared word for word with Tauri's
 * `profile_transition::selection_dialog_content`. Native menus are English-only and the
 * question appears before any profile (and so any saved UI locale) is opened, so it is not
 * localized; see dev-docs/DESKTOP_DATA_PROFILES.md.
 */
export interface SelectionDialogContent {
  title: string
  message: string
  detail: string
  /**
   * One button per candidate (most recently used first), then Quit when a third button is free
   * (rfd, used by Tauri, allows three). Without Quit, dismissal quits where the platform offers one;
   * a macOS NSAlert may not, so the user picks a profile there (harmless: nothing is moved).
   */
  buttons: string[]
}

const isoDate = (milliseconds: number) => new Date(milliseconds).toISOString().slice(0, 10)

export function selectionDialogContent(candidates: readonly TransitionCandidate[]): SelectionDialogContent {
  return {
    title: "Choose CodeNomad data",
    message: "CodeNomad found saved windows in more than one data profile. Which one should this installation use?",
    detail: [
      ...candidates.map((candidate) => `• ${candidate.name}: last used ${isoDate(candidate.lastUsed)}`),
      "",
      "Your choice is remembered and updates will not change it. Nothing is moved or deleted: the other profiles stay on disk and remain available with CODENOMAD_PROFILE=<name>. OpenCode sessions are shared by every profile.",
    ].join("\n"),
    buttons: [
      ...candidates.map((candidate) => `Use ${candidate.name}`),
      ...(candidates.length < 3 ? ["Quit"] : []),
    ],
  }
}

/** Maps a button index (or a dismissal) to the chosen profile key; anything else quits without remembering. */
export function selectedProfileKey(candidates: readonly TransitionCandidate[], response: number): string | undefined {
  return Number.isInteger(response) && response >= 0 ? candidates[response]?.key : undefined
}
