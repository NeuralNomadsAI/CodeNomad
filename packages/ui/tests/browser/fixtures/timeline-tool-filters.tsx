import { render } from "solid-js/web"
import MessageTimeline, { type TimelineSegment } from "../../../src/components/message-timeline"
import { resolveToolVisibility } from "../../../src/components/tool-call/tool-presentation"
import { transcriptPresetPatch, transcriptVisibilityPatch, transcriptVisibilityRows } from "../../../src/components/transcript-visibility"
import { I18nProvider } from "../../../src/lib/i18n"
import { ConfigProvider, preferences, updatePreferences, type ToolCallExpansionPreset, type VisibilityPreference } from "../../../src/stores/preferences"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

// Real timeline markers wired to Message content preferences as in MessageSection.
const tool = (index: number, toolName: string): TimelineSegment => ({ id: `tool-${index}`, messageId: `message-${index}`, type: "tool",
  label: toolName, tooltip: `Tool ${toolName}`, toolName, toolPartIds: [`part-${index}`], totalChars: 0 })
const segments: TimelineSegment[] = [
  { id: "user-0", messageId: "message-0", type: "user", label: "You", tooltip: "Question", totalChars: 0 },
  tool(1, "shell"), tool(2, "read"), tool(3, "custom_mcp_tool"),
  { id: "assistant-3", messageId: "message-3", type: "assistant", label: "Assistant", tooltip: "Answer", totalChars: 0 },
]
await applyUiSettings({ locale: "en", showTimelineTools: true })
const rows = transcriptVisibilityRows((key) => key)
render(() => <ConfigProvider><I18nProvider><ThemeProvider><div class="message-timeline-sidebar" style={{ height: "600px", width: "60px" }}>
  <MessageTimeline instanceId="timeline-filters" sessionId="timeline" segments={segments}
    showToolSegments={preferences().showTimelineTools}
    isToolHidden={(toolName) => resolveToolVisibility(preferences(), toolName) === "hidden"} />
</div></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  // The rail's geometry probe is a marker without a message.
  markers: () => [...document.querySelectorAll<HTMLElement>(".message-timeline-segment[data-message-id]")].map((marker) => marker.dataset.messageId),
  setTool: (key: string, mode: VisibilityPreference) => updatePreferences(transcriptVisibilityPatch(preferences(), rows.find((row) => row.key === key)!, mode)),
  preset: (preset: ToolCallExpansionPreset) => updatePreferences(transcriptPresetPatch(preset)),
}
