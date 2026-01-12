import { Component, createSignal, createEffect, onCleanup } from "solid-js"
import { Sparkles } from "lucide-solid"
import { getRandomLoadingVerb } from "../lib/loading-verbs"
import { getRandomPenguinFact } from "../lib/penguin-facts"

interface ThinkingCardProps {
  /** Whether the thinking state is active */
  isThinking: boolean
}

/**
 * A card displayed below user messages while the assistant is thinking.
 * Shows a fun loading verb that rotates every 3 seconds and a random penguin fact.
 */
const ThinkingCard: Component<ThinkingCardProps> = (props) => {
  const [loadingVerb, setLoadingVerb] = createSignal(getRandomLoadingVerb())
  const [penguinFact, setPenguinFact] = createSignal(getRandomPenguinFact())

  createEffect(() => {
    if (!props.isThinking) return

    // Update verb and fact immediately when thinking starts
    setLoadingVerb(getRandomLoadingVerb())
    setPenguinFact(getRandomPenguinFact())

    // Rotate verb every 3 seconds, fact every 8 seconds
    const verbInterval = setInterval(() => {
      setLoadingVerb(getRandomLoadingVerb())
    }, 3000)

    const factInterval = setInterval(() => {
      setPenguinFact(getRandomPenguinFact())
    }, 8000)

    onCleanup(() => {
      clearInterval(verbInterval)
      clearInterval(factInterval)
    })
  })

  if (!props.isThinking) return null

  return (
    <div class="thinking-card">
      <div class="thinking-card-header">
        <Sparkles class="thinking-card-icon" />
        <span class="thinking-card-verb">{loadingVerb()}...</span>
      </div>
      <div class="thinking-card-fact">
        <span class="thinking-card-fact-label">Fun fact:</span>
        <span class="thinking-card-fact-text">{penguinFact()}</span>
      </div>
    </div>
  )
}

export default ThinkingCard
