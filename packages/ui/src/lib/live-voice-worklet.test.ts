import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { runInNewContext } from "node:vm"
import { LIVE_VOICE_PLAYBACK_CAPACITY, LiveVoicePlayback } from "./live-voice-playback"

const code = readFileSync(new URL("./live-voice-worklet.js", import.meta.url), "utf8")

function worklet(rate: number, name: string, processorOptions: object, receive: (data: any) => void) {
  type Processor = {
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean
    port: { onmessage: (event: { data: unknown }) => void }
  }
  const processors = new Map<string, new (options: { processorOptions: object }) => Processor>()
  runInNewContext(code, {
    sampleRate: rate, ArrayBuffer, DataView, Int16Array,
    registerProcessor: (name: string, processor: new (options: { processorOptions: object }) => Processor) => {
      processors.set(name, processor)
    },
    AudioWorkletProcessor: class { port = { postMessage: receive } },
  })
  const Class = processors.get(`codenomad-live-${name}`)!
  return new Class({ processorOptions })
}

for (const rate of [16_000, 32_000, 44_100, 48_000, 96_000]) {
  for (const inputRate of [16_000, 24_000]) {
    test(`capture ${rate} Hz → ${inputRate} Hz stays aligned across render blocks`, () => {
      const chunks: ArrayBuffer[] = []
      const node = worklet(rate, "capture", { inputRate }, data => chunks.push(data))
      for (let offset = 0; offset < rate; offset += 128) {
        const length = Math.min(rate - offset, 128)
        const a = new Float32Array(length).fill(-1)
        const b = new Float32Array(length).fill(0.5)
        assert.ok(node.process([[a, b]], []))
        node.port.onmessage({ data: null })
      }
      assert.equal(chunks.length, 50)
      for (const chunk of chunks) {
        assert.equal(chunk.byteLength, inputRate * 2 / 50)
        const pcm = new DataView(chunk)
        for (let index = 0; index < pcm.byteLength; index += 2) assert.equal(pcm.getInt16(index, true), -8192)
      }
    })
  }
}

test("capture stops rather than queueing unbounded messages behind a busy renderer", () => {
  const chunks: unknown[] = []
  const node = worklet(48_000, "capture", { inputRate: 24_000 }, data => chunks.push(data))
  let active = true
  for (let index = 0; index < 300 && active; index++) active = node.process([[new Float32Array(128)]], [])
  assert.equal(active, false)
  assert.equal(chunks.length, 26)
  assert.equal(chunks.at(-1), "overrun")
})

for (const rate of [16_000, 24_000, 44_100, 48_000, 96_000]) test(`playback reports rendered PCM, then flushes the queued tail at ${rate} Hz`, () => {
  let rendered = 0
  const node = worklet(rate, "playback", { outputRate: 24_000, capacity: 2400 }, data => {
    assert.notEqual(data, "overrun")
    rendered = data.rendered
  })
  const pcm = new DataView(new ArrayBuffer(4800))
  for (let index = 0; index < pcm.byteLength; index += 2) pcm.setInt16(index, 16384, true)
  node.port.onmessage({ data: pcm.buffer })
  const play = (count: number) => {
    const samples = new Float32Array(count)
    node.process([], [[samples]])
    return samples
  }
  for (let index = 0; index < rate / 100; index += 128) {
    assert.ok(play(Math.min(rate / 100 - index, 128)).every(sample => sample === 0.5))
  }
  node.port.onmessage({ data: true })
  assert.equal(rendered, 240, "100 ms queued; only 10 ms rendered")
  assert.ok(play(128).every(sample => sample === 0))
  assert.equal(rendered, 240)
  node.port.onmessage({ data: pcm.buffer })
  assert.ok(play(128).every(sample => sample === 0.5), "a new turn plays after the flush")
})

test("playback tracks separate OpenAI items and never counts queued audio as played", () => {
  const audio = (itemId: string) => ({ type: "audio" as const, itemId, contentIndex: 0, pcm: "" })
  const playback = new LiveVoicePlayback()
  playback.append(24_000, audio("drained"))
  playback.append(4_800, audio("current"))
  playback.append(4_800, audio("queued"))
  playback.progress(24_000)
  assert.deepEqual(playback.interrupt(25_200), [
    { type: "truncate", itemId: "current", contentIndex: 0, audioEndMs: 50 },
    { type: "truncate", itemId: "queued", contentIndex: 0, audioEndMs: 0 },
  ])
  assert.equal(playback.append(LIVE_VOICE_PLAYBACK_CAPACITY, audio("full")), false)
  assert.deepEqual(playback.interrupt(25_200).at(-1), { type: "truncate", itemId: "full", contentIndex: 0, audioEndMs: 0 })
})

test("a fully rendered item only truncates while its response can still generate audio", () => {
  const playback = new LiveVoicePlayback()
  playback.append(2400, { type: "audio", itemId: "last", contentIndex: 2, pcm: "" })
  assert.deepEqual(playback.interrupt(2400), [
    { type: "truncate", itemId: "last", contentIndex: 2, audioEndMs: 100 },
  ])
  playback.turnComplete()
  assert.deepEqual(playback.interrupt(2400), [])
})
