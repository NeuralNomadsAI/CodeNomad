import { createContext, useContext } from "solid-js"
import type { AlignInTranscript } from "./search-highlight-ranges"

/** The transcript list's alignment, provided by each message row to the content it renders. */
export const TranscriptAlignmentContext = createContext<AlignInTranscript>()

export function useTranscriptAlignment(): AlignInTranscript | undefined {
  return useContext(TranscriptAlignmentContext)
}
