import { createSignal } from "solid-js"
import type { SpeechCapabilitiesResponse } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { getLogger } from "../lib/logger"

const log = getLogger("api")

function normalizeCapabilities(result: SpeechCapabilitiesResponse): SpeechCapabilitiesResponse {
  const r = result as unknown as Record<string, unknown>
  if (r.sttConfigured === undefined) r.sttConfigured = r.configured
  if (r.ttsConfigured === undefined) r.ttsConfigured = r.configured
  if (r.separateProviders === undefined) r.separateProviders = false
  return r as unknown as SpeechCapabilitiesResponse
}

const [speechCapabilities, setSpeechCapabilities] = createSignal<SpeechCapabilitiesResponse | null>(null)
const [speechCapabilitiesLoading, setSpeechCapabilitiesLoading] = createSignal(false)
const [speechCapabilitiesError, setSpeechCapabilitiesError] = createSignal<string | null>(null)
const [serverSupportsSeparateProviders, setServerSupportsSeparateProviders] = createSignal(true)

let speechCapabilitiesPromise: Promise<SpeechCapabilitiesResponse | null> | null = null

async function loadSpeechCapabilities(force = false): Promise<SpeechCapabilitiesResponse | null> {
  if (!force && speechCapabilities()) return speechCapabilities()
  if (speechCapabilitiesPromise) return speechCapabilitiesPromise

  setSpeechCapabilitiesLoading(true)
  setSpeechCapabilitiesError(null)
  speechCapabilitiesPromise = serverApi
    .fetchSpeechCapabilities()
    .then((result) => {
      const raw = result as unknown as Record<string, unknown>
      setServerSupportsSeparateProviders("separateProviders" in raw)
      const normalized = normalizeCapabilities(result)
      setSpeechCapabilities(normalized)
      setSpeechCapabilitiesError(null)
      return normalized
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
  setServerSupportsSeparateProviders(true)
}

export { speechCapabilities, speechCapabilitiesLoading, speechCapabilitiesError, serverSupportsSeparateProviders, loadSpeechCapabilities, resetSpeechCapabilities }
