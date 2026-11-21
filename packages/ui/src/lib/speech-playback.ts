import { serverApi } from "./api-client"
import { streamToMediaSource } from "./audio-utils"
import { tGlobal } from "./i18n"
import { formatToMimeType } from "./speech-playback-support"
import type { SpeechSettings } from "../stores/preferences"

export async function playSpeech(
  text: string, { playbackMode, ttsFormat }: Pick<SpeechSettings, "playbackMode" | "ttsFormat">,
  signal: AbortSignal, onPlaying?: () => void,
): Promise<void> {
  const response = await serverApi.synthesizeSpeechStream({ text, format: ttsFormat }, signal)
  let audio: HTMLAudioElement | undefined
  let url: string | undefined
  try {
    if (signal.aborted) throw signal.reason
    const error = () => new Error(tGlobal("messageItem.actions.speak.error.generate"))
    const mime = response.headers.get("content-type") || formatToMimeType(ttsFormat)
    const stream = response.body
    let media: MediaSource | undefined
    if (playbackMode === "streaming") {
      if (!stream) throw error()
      if (!MediaSource.isTypeSupported(mime)) {
        throw new Error(tGlobal("settings.speech.compatibility.browserStreamingUnavailable"))
      }
      media = new MediaSource()
      url = URL.createObjectURL(media)
    } else {
      const blob = await response.blob()
      if (signal.aborted) throw signal.reason
      url = URL.createObjectURL(blob.type ? blob : blob.slice(0, blob.size, mime))
    }
    const player = audio = new Audio(url)
    await new Promise<void>((resolve, reject) => {
      const listeners = new AbortController()
      const finish = () => { listeners.abort(); resolve() }
      const fail = (cause: unknown) => { listeners.abort(); reject(cause) }
      const once = { once: true, signal: listeners.signal }
      signal.addEventListener("abort", finish, once)
      player.addEventListener("ended", finish, once)
      player.addEventListener("error", () => fail(error()), once)
      const play = async () => {
        if (signal.aborted) throw signal.reason
        onPlaying?.()
        await player.play()
      }
      const start = () => { void play().catch(fail) }
      if (media && stream) {
        const source = media
        source.addEventListener("sourceopen", () => {
          // The first chunk can trigger play without being enough for the decoder.
          void streamToMediaSource(source, stream, mime, listeners.signal, start, error).catch(fail)
        }, once)
      } else start()
    })
  } finally {
    if (audio) {
      audio.pause()
      audio.currentTime = 0
      audio.src = ""
      audio.load()
    }
    if (url) URL.revokeObjectURL(url)
    if (response.body && !response.body.locked) void response.body.cancel().catch(() => {})
  }
}
