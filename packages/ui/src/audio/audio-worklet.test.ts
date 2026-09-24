import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  pcmRecorderProcessorCode,
  pcmStreamPlayerProcessorCode,
  PCM_RECORDER_PROCESSOR_NAME,
  PCM_STREAM_PLAYER_PROCESSOR_NAME,
} from "./index"

describe("AudioWorklet Processors DSP and Contract Tests", () => {
  describe("Module Code Export", () => {
    it("exports valid javascript code strings for both worklet processors", () => {
      assert.ok(typeof pcmRecorderProcessorCode === "string")
      assert.ok(pcmRecorderProcessorCode.length > 500)
      assert.ok(pcmRecorderProcessorCode.includes(`registerProcessor("${PCM_RECORDER_PROCESSOR_NAME}"`))

      assert.ok(typeof pcmStreamPlayerProcessorCode === "string")
      assert.ok(pcmStreamPlayerProcessorCode.length > 500)
      assert.ok(pcmStreamPlayerProcessorCode.includes(`registerProcessor("${PCM_STREAM_PLAYER_PROCESSOR_NAME}"`))
    })
  })

  describe("Downsampler Fractional Resampling Simulation", () => {
    function simulateDownsample(
      input: Float32Array,
      inputSampleRate: number,
      targetSampleRate: number
    ): Int16Array {
      const step = inputSampleRate / targetSampleRate
      const outputLength = Math.floor(input.length / step)
      const output = new Int16Array(outputLength)

      let inputIndex = 0
      for (let i = 0; i < outputLength; i++) {
        const nextIndex = Math.min(inputIndex + step, input.length)
        const startIndex = Math.floor(inputIndex)
        const endIndex = Math.ceil(nextIndex)

        let sum = 0
        let weightSum = 0

        for (let j = startIndex; j < endIndex && j < input.length; j++) {
          const segStart = Math.max(j, inputIndex)
          const segEnd = Math.min(j + 1, nextIndex)
          const weight = Math.max(0, segEnd - segStart)
          sum += input[j] * weight
          weightSum += weight
        }

        const sample = weightSum > 0 ? sum / weightSum : 0
        const clamped = Math.max(-1, Math.min(1, sample))
        output[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)

        inputIndex = nextIndex
      }

      return output
    }

    it("accurately downsamples 48kHz sine wave to 16kHz (Gemini target)", () => {
      const inputRate = 48000
      const targetRate = 16000
      const inputDurationSec = 0.05 // 50ms = 2400 samples at 48k
      const input = new Float32Array(inputRate * inputDurationSec)

      // 440 Hz test tone
      for (let i = 0; i < input.length; i++) {
        input[i] = Math.sin((2 * Math.PI * 440 * i) / inputRate)
      }

      const pcm16 = simulateDownsample(input, inputRate, targetRate)
      assert.equal(pcm16.length, 800) // 50ms at 16k = 800 samples

      // Check Int16 bounds
      for (let i = 0; i < pcm16.length; i++) {
        assert.ok(pcm16[i] >= -32768 && pcm16[i] <= 32767)
      }

      // Check non-zero peak
      let maxVal = 0
      for (let i = 0; i < pcm16.length; i++) {
        if (Math.abs(pcm16[i]) > maxVal) maxVal = Math.abs(pcm16[i])
      }
      assert.ok(maxVal > 25000, `Expected max amplitude near 32767, got ${maxVal}`)
    })

    it("accurately downsamples 44.1kHz to 24kHz (OpenAI target)", () => {
      const inputRate = 44100
      const targetRate = 24000
      const inputDurationSec = 0.04 // 40ms
      const input = new Float32Array(Math.floor(inputRate * inputDurationSec))

      for (let i = 0; i < input.length; i++) {
        input[i] = 0.75 * Math.sin((2 * Math.PI * 1000 * i) / inputRate)
      }

      const pcm24 = simulateDownsample(input, inputRate, targetRate)
      const expectedLength = Math.floor(input.length / (inputRate / targetRate))
      assert.equal(pcm24.length, expectedLength)

      for (let i = 0; i < pcm24.length; i++) {
        assert.ok(pcm24[i] >= -32768 && pcm24[i] <= 32767)
      }
    })
  })

  describe("Ring Buffer Player Simulation & Instant Barge-in Flush", () => {
    class SimulatedRingBufferPlayer {
      private ring: Float32Array
      private writeIndex = 0
      private readIndex = 0
      private available = 0
      private capacity: number

      constructor(capacity = 24000) {
        this.capacity = capacity
        this.ring = new Float32Array(capacity)
      }

      enqueue(pcmInt16: Int16Array) {
        for (let i = 0; i < pcmInt16.length; i++) {
          this.ring[this.writeIndex] = pcmInt16[i] / 32768
          this.writeIndex = (this.writeIndex + 1) % this.capacity
          if (this.available < this.capacity) {
            this.available++
          } else {
            this.readIndex = (this.readIndex + 1) % this.capacity
          }
        }
      }

      render(output: Float32Array): number {
        const toRender = Math.min(output.length, this.available)
        for (let i = 0; i < toRender; i++) {
          output[i] = this.ring[this.readIndex]
          this.readIndex = (this.readIndex + 1) % this.capacity
        }
        for (let i = toRender; i < output.length; i++) {
          output[i] = 0
        }
        this.available -= toRender
        return toRender
      }

      flush() {
        this.readIndex = this.writeIndex
        this.available = 0
      }

      getBufferedSamples(): number {
        return this.available
      }
    }

    it("queues audio and plays smoothly across render quanta", () => {
      const player = new SimulatedRingBufferPlayer(48000)
      const incomingPcm = new Int16Array(480) // 20ms chunk at 24kHz
      incomingPcm.fill(16000)

      player.enqueue(incomingPcm)
      assert.equal(player.getBufferedSamples(), 480)

      const outputQuantum1 = new Float32Array(128)
      const rendered1 = player.render(outputQuantum1)
      assert.equal(rendered1, 128)
      assert.equal(player.getBufferedSamples(), 480 - 128)
      assert.ok(Math.abs(outputQuantum1[0] - 16000 / 32768) < 0.001)

      const outputQuantum2 = new Float32Array(128)
      const rendered2 = player.render(outputQuantum2)
      assert.equal(rendered2, 128)
      assert.equal(player.getBufferedSamples(), 480 - 256)
    })

    it("instantly drops buffered audio on flush with zero residual playback", () => {
      const player = new SimulatedRingBufferPlayer(48000)
      const incomingPcm = new Int16Array(2400) // 100ms
      incomingPcm.fill(20000)

      player.enqueue(incomingPcm)
      assert.equal(player.getBufferedSamples(), 2400)

      // Model interrupted by user barge-in!
      player.flush()
      assert.equal(player.getBufferedSamples(), 0)

      const outputQuantum = new Float32Array(128)
      const rendered = player.render(outputQuantum)
      assert.equal(rendered, 0)
      // All output should be silence (0)
      for (let i = 0; i < outputQuantum.length; i++) {
        assert.equal(outputQuantum[i], 0)
      }
    })
  })
})
