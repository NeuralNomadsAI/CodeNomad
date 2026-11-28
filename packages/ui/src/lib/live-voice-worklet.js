// Capture averages fractional source frames across render quanta. Integer
// weights keep 44.1 kHz (and other non-integral ratios) from drifting.
class Capture extends AudioWorkletProcessor {
  constructor({ processorOptions: { inputRate } }) {
    super()
    this.rate = inputRate
    this.frames = inputRate / 50
    this.pending = 0
    this.weight = 0
    this.sum = 0
    this.used = 0
    this.chunk = new DataView(new ArrayBuffer(this.frames * 2))
    this.port.onmessage = () => { this.pending-- }
  }

  process([input]) {
    if (!this.chunk) return false
    if (!input?.length) return true
    for (let index = 0; index < input[0].length; index++) {
      let value = 0
      for (const channel of input) value += channel[index]
      value /= input.length
      let remaining = this.rate
      while (remaining) {
        const weight = Math.min(remaining, sampleRate - this.weight)
        remaining -= weight
        this.sum += value * weight
        this.weight += weight
        if (this.weight !== sampleRate) continue
        const sample = Math.max(-1, Math.min(1, this.sum / sampleRate))
        this.chunk.setInt16(this.used++ * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
        this.sum = this.weight = 0
        if (this.used !== this.frames) continue
        if (this.pending === 25) {
          this.port.postMessage("overrun")
          this.chunk = null
          return false
        }
        const { buffer } = this.chunk
        this.port.postMessage(buffer, [buffer])
        this.pending++
        this.used = 0
        this.chunk = new DataView(new ArrayBuffer(this.frames * 2))
      }
    }
    return true
  }
}

class Playback extends AudioWorkletProcessor {
  constructor({ processorOptions: { outputRate, capacity } }) {
    super()
    this.rate = outputRate
    this.ring = new Int16Array(capacity)
    this.read = this.write = this.count = this.phase = this.rendered = this.reported = 0
    this.port.onmessage = ({ data }) => {
      if (!(data instanceof ArrayBuffer)) {
        this.port.postMessage({ flush: true, rendered: this.rendered })
        if (data === true) {
          this.read = this.write = this.count = this.phase = this.rendered = this.reported = 0
        } else {
          // Keep the unread prefix and rebase only after reporting the actual cut.
          this.count = Math.max(0, Math.min(this.count, data.keepThrough - this.rendered))
          this.write = (this.read + this.count) % this.ring.length
          this.rendered = this.reported = Math.min(this.rendered, data.keepThrough)
          if (!this.count) this.phase = 0
        }
        return
      }
      const pcm = new DataView(data)
      if (pcm.byteLength / 2 > this.ring.length - this.count) {
        this.port.postMessage("overrun")
        return
      }
      for (let index = 0; index < pcm.byteLength; index += 2) {
        this.ring[this.write] = pcm.getInt16(index, true)
        this.write = (this.write + 1) % this.ring.length
        this.count++
      }
    }
  }

  process(_inputs, [channels]) {
    const output = channels?.[0]
    if (!output) return true
    for (let index = 0; index < output.length && this.count; index++) {
      const a = this.ring[this.read]
      const b = this.count > 1 ? this.ring[(this.read + 1) % this.ring.length] : a
      output[index] = (a + (b - a) * this.phase / sampleRate) / 32768
      this.phase += this.rate
      const consumed = Math.min(this.count, Math.floor(this.phase / sampleRate))
      this.count -= consumed
      this.rendered += consumed
      this.read = (this.read + consumed) % this.ring.length
      this.phase = this.count ? this.phase % sampleRate : 0
    }
    if (this.rendered - this.reported >= this.rate / 50 || (!this.count && this.rendered !== this.reported)) {
      this.reported = this.rendered
      this.port.postMessage({ rendered: this.rendered })
    }
    return true
  }
}

registerProcessor("codenomad-live-capture", Capture)
registerProcessor("codenomad-live-playback", Playback)
