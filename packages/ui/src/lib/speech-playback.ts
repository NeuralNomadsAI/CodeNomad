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
    signal.throwIfAborted()
    const error = () => new Error(tGlobal("messageItem.actions.speak.error.generate"))
    const mime = response.headers.get("content-type") || formatToMimeType(ttsFormat)
    let media: MediaSource | undefined
    if (playbackMode === "streaming") {
      if (!response.body) throw error()
      if (!MediaSource.isTypeSupported(mime)) {
        throw new Error(tGlobal("settings.speech.compatibility.browserStreamingUnavailable"))
      }
      media = new MediaSource()
      url = URL.createObjectURL(media)
    } else {
      const blob = await response.blob()
      signal.throwIfAborted()
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
        signal.throwIfAborted()
        onPlaying?.()
        await player.play()
      }
      if (media) {
        const source = media
        source.addEventListener("sourceopen", () => {
          void streamToMediaSource(source, response.body!, mime, listeners.signal, play, error).catch(fail)
        }, once)
      } else void play().catch(fail)
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
