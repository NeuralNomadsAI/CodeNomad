/**
 * PCM Stream Player Processor
 *
 * Runs on Web Audio render thread.
 * Maintains a pre-allocated circular ring buffer (Float32Array).
 * Accepts incoming Int16Array PCM chunks from port.onmessage,
 * converts to Float32, writes to ring buffer, and plays to output channels.
 * Instantly flushes buffered playback on { type: "FLUSH" } for barge-in / model interruption.
 */

export interface PcmStreamPlayerProcessorOptions {
  bufferCapacitySeconds?: number
}

export type PcmStreamPlayerMessage =
  | { type: "FLUSH" }
  | { type: "FEED"; pcm: Int16Array | ArrayBuffer }
  | ArrayBuffer
  | Int16Array

export const PCM_STREAM_PLAYER_PROCESSOR_NAME = "pcm-stream-player-processor"

export const pcmStreamPlayerProcessorCode = `
class PcmStreamPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options?.processorOptions || {};
    const bufferSeconds = processorOptions.bufferCapacitySeconds || 10;

    // Buffer capacity (~10s at current sample rate, e.g. 24000 * 10 = 240,000 or 48000 * 10 = 480,000)
    this.capacity = Math.max(128, Math.round(sampleRate * bufferSeconds));
    this.ringBuffer = new Float32Array(this.capacity);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.bufferedCount = 0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;

      // Handle FLUSH message: immediately discard all buffered audio with 0 delay (crucial for barge-in)
      if (data === "FLUSH" || data.type === "FLUSH") {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.bufferedCount = 0;
        return;
      }

      // Handle audio chunk payload (either raw Int16Array / ArrayBuffer, or wrapped in object)
      let int16Data = null;
      if (data instanceof Int16Array) {
        int16Data = data;
      } else if (data instanceof ArrayBuffer) {
        int16Data = new Int16Array(data);
      } else if (data.pcm) {
        if (data.pcm instanceof Int16Array) {
          int16Data = data.pcm;
        } else if (data.pcm instanceof ArrayBuffer) {
          int16Data = new Int16Array(data.pcm);
        }
      }

      if (int16Data) {
        const len = int16Data.length;
        const capacity = this.capacity;

        for (let i = 0; i < len; i++) {
          const sample = int16Data[i] / 32768.0;
          this.ringBuffer[this.writeIndex] = sample;
          this.writeIndex = (this.writeIndex + 1) % capacity;

          if (this.bufferedCount < capacity) {
            this.bufferedCount++;
          } else {
            // Overrun: advance readIndex to drop oldest unread sample
            this.readIndex = (this.readIndex + 1) % capacity;
          }
        }
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }

    const channelCount = output.length;
    const outputLength = output[0].length;
    const capacity = this.capacity;

    for (let i = 0; i < outputLength; i++) {
      let sample = 0.0;
      if (this.bufferedCount > 0) {
        sample = this.ringBuffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % capacity;
        this.bufferedCount--;
      }

      for (let ch = 0; ch < channelCount; ch++) {
        output[ch][i] = sample;
      }
    }

    return true;
  }
}

registerProcessor("${PCM_STREAM_PLAYER_PROCESSOR_NAME}", PcmStreamPlayerProcessor);
`
