import type { SpeechSettingsUpdate } from "../stores/preferences"

export function buildSpeechPatch(updates: SpeechSettingsUpdate): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  if (updates.separateProviders !== undefined) patch.separateProviders = updates.separateProviders
  if (updates.apiKey !== undefined) patch.apiKey = updates.apiKey
  if (updates.baseUrl !== undefined) patch.baseUrl = updates.baseUrl?.trim() || null
  if (updates.sttModel !== undefined) patch.sttModel = updates.sttModel?.trim() || null
  if (updates.ttsModel !== undefined) patch.ttsModel = updates.ttsModel?.trim() || null
  if (updates.ttsVoice !== undefined) patch.ttsVoice = updates.ttsVoice?.trim() || null
  if (updates.playbackMode !== undefined) patch.playbackMode = updates.playbackMode
  if (updates.ttsFormat !== undefined) patch.ttsFormat = updates.ttsFormat

  for (const dir of ["stt", "tts"] as const) {
    const dirUpdate = updates[dir]
    if (dirUpdate) {
      const dirPatch: Record<string, unknown> = {}
      if (dirUpdate.apiKey !== undefined) dirPatch.apiKey = dirUpdate.apiKey
      if (dirUpdate.baseUrl !== undefined) dirPatch.baseUrl = dirUpdate.baseUrl?.trim() || null
      if (dirUpdate.model !== undefined) dirPatch.model = dirUpdate.model?.trim() || null
      if (Object.keys(dirPatch).length > 0) patch[dir] = dirPatch
    }
  }

  return patch
}
