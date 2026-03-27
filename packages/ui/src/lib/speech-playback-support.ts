import type { SpeechCapabilitiesResponse } from "../../../server/src/api-types"
import type { SpeechPlaybackMode, SpeechTtsFormat } from "../stores/preferences"

export interface SpeechPlaybackSupportResult {
  available: boolean
  reason?: "unsupported-environment" | "provider-streaming-unavailable" | "browser-streaming-unavailable"
}

export function formatToMimeType(format: SpeechTtsFormat): string {
  if (format === "wav") return "audio/wav"
  if (format === "opus") return getSupportedMimeType(format)
  if (format === "aac") return "audio/aac"
  return "audio/mpeg"
}

export function getCandidateMimeTypes(format: SpeechTtsFormat): string[] {
  if (format === "wav") return ["audio/wav"]
  if (format === "opus") {
    return ['audio/ogg; codecs="opus"', 'audio/webm; codecs="opus"', "audio/opus"]
  }
  if (format === "aac") return ["audio/aac", "audio/mp4", 'audio/mp4; codecs="mp4a.40.2"']
  return ["audio/mpeg"]
}

export function getSupportedMimeType(format: SpeechTtsFormat): string {
  const candidates = getCandidateMimeTypes(format)
  if (typeof MediaSource === "undefined") {
    return candidates[0]
  }
  return candidates.find((candidate) => MediaSource.isTypeSupported(candidate)) ?? candidates[0]
}

export function getSpeechPlaybackSupport(options: {
  playbackMode: SpeechPlaybackMode
  ttsFormat: SpeechTtsFormat
  capabilities?: SpeechCapabilitiesResponse | null
}): SpeechPlaybackSupportResult {
  if (typeof window === "undefined" || typeof window.Audio === "undefined") {
    return { available: false, reason: "unsupported-environment" }
  }

  if (options.playbackMode !== "streaming") {
    return { available: true }
  }

  if (!options.capabilities?.supportsStreamingTts) {
    return { available: false, reason: "provider-streaming-unavailable" }
  }

  if (
    typeof MediaSource === "undefined" ||
    !getCandidateMimeTypes(options.ttsFormat).some((candidate) => MediaSource.isTypeSupported(candidate))
  ) {
    return { available: false, reason: "browser-streaming-unavailable" }
  }

  return { available: true }
}
