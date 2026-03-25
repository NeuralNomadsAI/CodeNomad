import { createSignal } from "solid-js"
import type { SpeechCapabilitiesResponse } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { getLogger } from "../lib/logger"

const log = getLogger("api")

const [speechCapabilities, setSpeechCapabilities] = createSignal<SpeechCapabilitiesResponse | null>(null)
const [speechCapabilitiesLoading, setSpeechCapabilitiesLoading] = createSignal(false)
const [speechCapabilitiesError, setSpeechCapabilitiesError] = createSignal<string | null>(null)

let speechCapabilitiesPromise: Promise<SpeechCapabilitiesResponse | null> | null = null

async function loadSpeechCapabilities(force = false): Promise<SpeechCapabilitiesResponse | null> {
  if (!force && speechCapabilities()) return speechCapabilities()
  if (speechCapabilitiesPromise) return speechCapabilitiesPromise

  setSpeechCapabilitiesLoading(true)
  setSpeechCapabilitiesError(null)
  speechCapabilitiesPromise = serverApi
    .fetchSpeechCapabilities()
    .then((result) => {
      setSpeechCapabilities(result)
      setSpeechCapabilitiesError(null)
      return result
    })
    .catch((error) => {
      log.error("Failed to load speech capabilities", error)
      setSpeechCapabilities(null)
      setSpeechCapabilitiesError(error instanceof Error ? error.message : String(error))
      return null
    })
    .finally(() => {
      setSpeechCapabilitiesLoading(false)
      speechCapabilitiesPromise = null
    })

  return speechCapabilitiesPromise
}

function resetSpeechCapabilities(): void {
  setSpeechCapabilities(null)
  setSpeechCapabilitiesError(null)
}

export { speechCapabilities, speechCapabilitiesLoading, speechCapabilitiesError, loadSpeechCapabilities, resetSpeechCapabilities }
