import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { test } from "node:test"
import { resolveSystemSpeechLocale } from "../../../desktop-speech/contract"
import { runSystemDictation, SystemSpeechFailure } from "./device-speech-system"
import type { SpeechOperationControl } from "./device-speech"

function operation(source: string) {
  const events = new EventEmitter()
  const abort = new AbortController()
  const finish = new AbortController()
  const control: SpeechOperationControl = {
    signal: abort.signal, finish: finish.signal,
    waitForAudio: async () => undefined,
    revokePermission: () => abort.abort(),
    progress: ({ state }) => events.emit(state),
  }
  const result = runSystemDictation(process.execPath, ["-e", source], control)
  return { result, events, abort, finish }
}

test("system locales never silently fall back from an explicit region", () => {
  const locales = ["en-GB", "en-US", "fr-CA", "de-DE"]
  assert.equal(resolveSystemSpeechLocale(locales, "en"), "en-US")
  assert.equal(resolveSystemSpeechLocale(locales, "en-gb"), "en-GB")
  assert.equal(resolveSystemSpeechLocale(locales, "fr"), "fr-CA")
  assert.equal(resolveSystemSpeechLocale(locales, "fr-FR"), undefined)
  assert.equal(resolveSystemSpeechLocale(locales, "es"), undefined)
})

test("finish sends one control message and accepts text after native exit", { timeout: 5000 }, async () => {
  const { result, events, finish } = operation(`
    const emit = frame => console.log(JSON.stringify(frame))
    process.stdin.once("data", chunk => {
      if (chunk.toString() !== "finish\\n") process.exit(1)
      emit({ progress: { state: "transcribing" } })
      emit({ value: "Bonjour" })
      process.stdout.write("", () => process.exit(0))
    })
    emit({ progress: { state: "recording" } })
  `)
  await once(events, "recording")
  const processing = once(events, "transcribing")
  finish.abort()
  await processing
  assert.equal(await result, "Bonjour")
})

test("cancellation waits for a stalled system helper to stop and discards its output", { timeout: 5000 }, async () => {
  const { result, events, abort } = operation(`
    console.log('{"progress":{"state":"recording"}}')
    process.stdin.once("end", () => console.log('{"value":"discard"}'))
    process.stdin.resume()
    setInterval(() => {}, 1000)
  `)
  await once(events, "recording")
  abort.abort()
  await assert.rejects(result, SystemSpeechFailure)
})

test("system permission and locale refusals keep their status", async () => {
  for (const error of ["localeUnavailable", "permissionDenied"]) {
    await assert.rejects(operation(`console.log(${JSON.stringify(JSON.stringify({ error }))})`).result,
      cause => cause instanceof SystemSpeechFailure && cause.code === error)
  }
})
