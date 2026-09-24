import { createEffect, onCleanup, onMount } from "solid-js"

export interface AudioVisualizerCanvasProps {
  analyserNode: AnalyserNode | null
  active: boolean
  class?: string
  width?: number
  height?: number
  barCount?: number
  gap?: number
}

/**
 * Renders an animated audio spectrum/waveform onto a <canvas> element using requestAnimationFrame.
 * CRITICAL: Do NOT store FFT / time-domain audio data into SolidJS signals (avoid reactive thrashing).
 * Reads analyser.getByteFrequencyData() directly in the canvas draw loop.
 * Strictly square styling: crisp vertical bars matching CodeNomad's aesthetic.
 * Handles DPI scaling (window.devicePixelRatio) so the canvas is razor-sharp.
 */
export function AudioVisualizerCanvas(props: AudioVisualizerCanvasProps) {
  let canvasRef: HTMLCanvasElement | undefined
  let animationFrameId: number | null = null

  const getComputedStyleColor = (variable: string, fallback: string): string => {
    if (typeof window === "undefined" || !canvasRef) return fallback
    const val = getComputedStyle(canvasRef).getPropertyValue(variable).trim()
    return val || fallback
  }

  const draw = () => {
    if (!canvasRef) return

    const canvas = canvasRef
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const displayWidth = rect.width > 0 ? rect.width : (props.width ?? 320)
    const displayHeight = rect.height > 0 ? rect.height : (props.height ?? 64)

    const expectedWidth = Math.round(displayWidth * dpr)
    const expectedHeight = Math.round(displayHeight * dpr)

    if (canvas.width !== expectedWidth || canvas.height !== expectedHeight) {
      canvas.width = expectedWidth
      canvas.height = expectedHeight
    }

    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, displayWidth, displayHeight)

    const primaryColor = getComputedStyleColor("--accent-primary", "#0066ff")
    const mutedColor = getComputedStyleColor("--text-muted", "#475569")
    const gridColor = getComputedStyleColor("--border-divider", "#e0e0e0")

    // Draw baseline / grid reference
    ctx.strokeStyle = gridColor
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, displayHeight - 0.5)
    ctx.lineTo(displayWidth, displayHeight - 0.5)
    ctx.stroke()

    const analyser = props.analyserNode

    if (props.active && analyser) {
      const bufferLength = analyser.frequencyBinCount
      const dataArray = new Uint8Array(bufferLength)
      analyser.getByteFrequencyData(dataArray)

      const numBars = props.barCount ?? 32
      const gap = props.gap ?? 2
      const totalGap = gap * (numBars - 1)
      const barWidth = Math.max(1, Math.floor((displayWidth - totalGap) / numBars))
      const step = Math.max(1, Math.floor(bufferLength / numBars))

      for (let i = 0; i < numBars; i++) {
        // Average or sample a range of frequencies for smooth response
        let sum = 0
        const sampleCount = Math.min(step, bufferLength - i * step)
        for (let j = 0; j < sampleCount; j++) {
          sum += dataArray[i * step + j]
        }
        const avg = sampleCount > 0 ? sum / sampleCount : 0
        const percent = avg / 255
        // Minimum bar height of 2px so it feels responsive and alive
        const barHeight = Math.max(2, Math.floor(percent * (displayHeight - 4)))

        const x = i * (barWidth + gap)
        const y = displayHeight - barHeight

        ctx.fillStyle = primaryColor
        // Crisp square rect with no rounding
        ctx.fillRect(x, y, barWidth, barHeight)
      }
    } else {
      // Idle state: subtle flat baseline activity indicators (crisp square ticks)
      const numBars = props.barCount ?? 32
      const gap = props.gap ?? 2
      const totalGap = gap * (numBars - 1)
      const barWidth = Math.max(1, Math.floor((displayWidth - totalGap) / numBars))

      ctx.fillStyle = mutedColor
      for (let i = 0; i < numBars; i++) {
        const x = i * (barWidth + gap)
        const y = displayHeight - 2
        ctx.fillRect(x, y, barWidth, 2)
      }
    }

    ctx.restore()

    if (props.active) {
      animationFrameId = requestAnimationFrame(draw)
    }
  }

  const startLoop = () => {
    stopLoop()
    if (props.active) {
      animationFrameId = requestAnimationFrame(draw)
    } else {
      draw()
    }
  }

  const stopLoop = () => {
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
  }

  createEffect(() => {
    // Reacts to active state and analyser node attachment
    const active = props.active
    void props.analyserNode

    if (active) {
      startLoop()
    } else {
      stopLoop()
      draw()
    }
  })

  onMount(() => {
    startLoop()
  })

  onCleanup(() => {
    stopLoop()
  })

  return (
    <canvas
      ref={canvasRef}
      class={`live-voice-hud-canvas ${props.class ?? ""}`}
      style={{
        width: "100%",
        height: `${props.height ?? 64}px`,
      }}
    />
  )
}
export default AudioVisualizerCanvas
