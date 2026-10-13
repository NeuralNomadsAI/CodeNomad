import "./session"
import { sseManager } from "../../../src/lib/sse-manager"
import { applyUiSettings } from "./ui-settings"

// Reuse the real SessionView/native dispatcher fixture; drive lifecycle events
// independently from text deltas so token-free thinking can also be measured.
const instanceId = "browser-instance", sessionID = "browser-session", assistantMessageID = "msg_assistant"
let time = Date.now()
let grouped = false
const emit = (type: string, data: object = {}) => (sseManager as any).handleEvent(instanceId, {
  id: `motion-${++time}`, type, created: time, location: { directory: "/fixture" },
  data: { sessionID, assistantMessageID, ...data },
})
await applyUiSettings({ locale: "en", showThinkingBlocks: true,
  toolCallExpansionDefaults: { preset: "custom", thinking: "expanded", tools: {} } })
const fixture = (window as any).fixture
;(window as any).motionFixture = {
  seed: () => fixture.seedHistory(620),
  start: () => {
    emit("session.execution.started")
    fixture.startEmpty()
    emit("session.reasoning.started")
    emit("session.reasoning.delta", { ordinal: 0, delta: "**Considering the answer**\n\nInitial reasoning." })
  },
  text: () => emit("session.text.started"),
  groupThinking: () => {
    emit("session.reasoning.ended", { ordinal: 0, text: "**Considering the answer**\n\nInitial reasoning." })
    emit("session.reasoning.started")
    emit("session.reasoning.delta", { ordinal: 1, delta: "**Checking the result**\n\nAnother reasoning step." })
    grouped = true
  },
  delta: (delta: string) => fixture.delta(delta),
  finish: (text: string) => {
    emit("session.reasoning.ended", { ordinal: 0, text: "**Considering the answer**\n\nInitial reasoning." })
    if (grouped) emit("session.reasoning.ended", { ordinal: 1, text: "**Checking the result**\n\nAnother reasoning step." })
    fixture.end(text)
    emit("session.step.ended", { finish: "stop" })
    emit("session.execution.succeeded")
  },
}
