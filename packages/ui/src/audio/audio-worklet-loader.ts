/**
 * Audio Worklet Loader
 *
 * Provides helper function to load and register both PCM recorder and player
 * AudioWorklet processors into an AudioContext instance.
 *
 * Uses inline Blob URLs to ensure 100% compatibility across Vite dev server,
 * production bundles, Electron, and Tauri (avoiding 404s on external file paths).
 */

import {
  PCM_RECORDER_PROCESSOR_NAME,
  pcmRecorderProcessorCode,
} from "./pcm-recorder-processor.ts"
import {
  PCM_STREAM_PLAYER_PROCESSOR_NAME,
  pcmStreamPlayerProcessorCode,
} from "./pcm-stream-player-processor.ts"

// WeakSet to avoid re-adding processors to the same AudioContext instance
const loadedContexts = new WeakSet<AudioContext>()

/**
 * Creates an object URL from JavaScript code string.
 */
function createWorkletBlobUrl(code: string): string {
  const blob = new Blob([code], { type: "application/javascript" })
  return URL.createObjectURL(blob)
}

/**
 * Loads and registers both AudioWorklet processors (recorder & player) into the given AudioContext.
 *
 * @param audioContext - The target AudioContext.
 */
export async function loadAudioWorkletModules(audioContext: AudioContext): Promise<void> {
  if (loadedContexts.has(audioContext)) {
    return
  }

  const recorderBlobUrl = createWorkletBlobUrl(pcmRecorderProcessorCode)
  const playerBlobUrl = createWorkletBlobUrl(pcmStreamPlayerProcessorCode)

  try {
    await Promise.all([
      audioContext.audioWorklet.addModule(recorderBlobUrl),
      audioContext.audioWorklet.addModule(playerBlobUrl),
    ])
    loadedContexts.add(audioContext)
  } finally {
    // Revoke the Blob URLs once loading has settled to prevent memory leaks
    URL.revokeObjectURL(recorderBlobUrl)
    URL.revokeObjectURL(playerBlobUrl)
  }
}

export {
  PCM_RECORDER_PROCESSOR_NAME,
  PCM_STREAM_PLAYER_PROCESSOR_NAME,
  pcmRecorderProcessorCode,
  pcmStreamPlayerProcessorCode,
}
