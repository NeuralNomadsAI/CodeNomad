/**
 * PCM Recorder Processor
 *
 * Runs on Web Audio render thread.
 * Downsamples Float32 audio (mono/multichannel) to target rate (16kHz Gemini, 24kHz OpenAI),
 * converts to Int16 linear PCM, batches chunks, measures RMS, and transfers buffers.
 */

export interface PcmRecorderProcessorOptions {
  targetSampleRate?: number
  chunkDurationMs?: number
}

export interface PcmRecorderMessageEvent {
  pcm: ArrayBuffer
  rms: number
}

export const PCM_RECORDER_PROCESSOR_NAME = "pcm-recorder-processor"

export const pcmRecorderProcessorCode = `
class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options?.processorOptions || {};
    this.targetSampleRate = processorOptions.targetSampleRate || 16000;
    this.chunkDurationMs = processorOptions.chunkDurationMs || 40;

    // Calculate buffer size in output samples (e.g. 16000 * 0.04 = 640 samples)
    this.outputChunkSize = Math.max(128, Math.round((this.targetSampleRate * this.chunkDurationMs) / 1000));

    // Pre-allocated output batch buffer
    this.outputBuffer = new Int16Array(this.outputChunkSize);
    this.outputIndex = 0;

    // Fractional resampling accumulator state
    this.resampleRatio = currentFrame === 0 ? (sampleRate / this.targetSampleRate) : (sampleRate / this.targetSampleRate);
    this.sourceSampleRate = sampleRate;
    this.ratio = this.sourceSampleRate / this.targetSampleRate;
    this.inputAccumulator = 0.0;
    this.inputAccumulatorWeight = 0.0;

    // RMS tracking for the current chunk
    this.sumSquare = 0.0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "CONFIG") {
        if (typeof data.targetSampleRate === "number" && data.targetSampleRate > 0) {
          this.targetSampleRate = data.targetSampleRate;
          this.ratio = this.sourceSampleRate / this.targetSampleRate;
        }
        if (typeof data.chunkDurationMs === "number" && data.chunkDurationMs > 0) {
          this.chunkDurationMs = data.chunkDurationMs;
        }
        this.outputChunkSize = Math.max(128, Math.round((this.targetSampleRate * this.chunkDurationMs) / 1000));
        this.outputBuffer = new Int16Array(this.outputChunkSize);
        this.outputIndex = 0;
        this.inputAccumulator = 0.0;
        this.inputAccumulatorWeight = 0.0;
        this.sumSquare = 0.0;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channelCount = input.length;
    const inputLength = input[0].length;
    if (inputLength === 0) {
      return true;
    }

    const ratio = this.ratio;

    for (let i = 0; i < inputLength; i++) {
      // Downmix input channels to mono Float32
      let sample = 0.0;
      for (let ch = 0; ch < channelCount; ch++) {
        sample += input[ch][i];
      }
      sample /= channelCount;

      let weightRemaining = 1.0;

      while (weightRemaining > 0) {
        const needed = ratio - this.inputAccumulatorWeight;
        if (weightRemaining >= needed) {
          this.inputAccumulator += sample * needed;
          this.inputAccumulatorWeight += needed;
          weightRemaining -= needed;

          // Compute output sample value
          const outSample = this.inputAccumulator / ratio;
          this.inputAccumulator = 0.0;
          this.inputAccumulatorWeight = 0.0;

          // Track RMS on float sample
          this.sumSquare += outSample * outSample;

          // Clamp and convert to linear 16-bit signed PCM
          let clamped = Math.max(-1.0, Math.min(1.0, outSample));
          let int16Val = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
          if (int16Val > 32767) int16Val = 32767;
          if (int16Val < -32768) int16Val = -32768;

          this.outputBuffer[this.outputIndex++] = int16Val;

          if (this.outputIndex >= this.outputChunkSize) {
            const rms = Math.sqrt(this.sumSquare / this.outputChunkSize);
            const pcmBuffer = this.outputBuffer.buffer;

            this.port.postMessage(
              {
                type: "DATA",
                pcm: pcmBuffer,
                rms: rms,
              },
              [pcmBuffer]
            );

            // Re-allocate fresh buffer for next chunk since buffer ownership transferred
            this.outputBuffer = new Int16Array(this.outputChunkSize);
            this.outputIndex = 0;
            this.sumSquare = 0.0;
          }
        } else {
          this.inputAccumulator += sample * weightRemaining;
          this.inputAccumulatorWeight += weightRemaining;
          weightRemaining = 0.0;
        }
      }
    }

    return true;
  }
}

registerProcessor("${PCM_RECORDER_PROCESSOR_NAME}", PcmRecorderProcessor);
`
