class HexPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(2048)
    this.used = 0
    this.running = true
    this.port.onmessage = () => {
      this.running = false
      this.flush()
      this.port.postMessage(null)
    }
  }

  flush() {
    if (!this.used) return
    const chunk = this.used === this.buffer.length ? this.buffer : this.buffer.slice(0, this.used)
    this.port.postMessage(chunk, [chunk.buffer])
    this.buffer = new Float32Array(2048)
    this.used = 0
  }

  process([input]) {
    if (!this.running) return false
    if (!input?.length) return true
    for (let i = 0; i < input[0].length; i++) {
      let value = 0
      for (const channel of input) value += channel[i]
      this.buffer[this.used++] = value / input.length
      if (this.used === this.buffer.length) this.flush()
    }
    return true
  }
}

registerProcessor("codenomad-hex-pcm", HexPcmProcessor)
