export class FrameBudget {
  private frames = 0
  private bytes = 0

  constructor(
    private readonly maxFrames: number,
    private readonly maxBytes: number,
  ) {
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("Remote Control frame budget limits must be positive integers")
    }
  }

  reserve(byteLength: number): (() => void) | null {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new RangeError("Remote Control frame size must be a non-negative integer")
    }
    if (this.frames >= this.maxFrames || byteLength > this.maxBytes - this.bytes) return null
    this.frames += 1
    this.bytes += byteLength
    let active = true
    return () => {
      if (!active) return
      active = false
      this.frames -= 1
      this.bytes -= byteLength
    }
  }

  usage(): { frames: number; bytes: number } {
    return { frames: this.frames, bytes: this.bytes }
  }
}
