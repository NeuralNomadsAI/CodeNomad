import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import LiveVoiceHud from "../../../src/components/voice/live-voice-hud"
import "../../../src/index.css"

function Fixture() {
  const [open, setOpen] = createSignal(false)

  return (
    <div style={{ padding: "20px" }}>
      <button
        id="open-voice-hud-btn"
        type="button"
        onClick={() => setOpen(true)}
      >
        Open Live Voice HUD
      </button>

      <LiveVoiceHud
        open={open()}
        onClose={() => setOpen(false)}
        status="idle"
        provider="gemini"
        transcripts={[
          { id: "1", speaker: "user", text: "Hello CodeNomad Voice" },
          { id: "2", speaker: "assistant", text: "Hello! How can I help you code today?" },
        ]}
      />
    </div>
  )
}

const root = document.getElementById("root")
if (root) {
  render(
    () => (
      <ConfigProvider>
        <I18nProvider>
          <ThemeProvider>
            <Fixture />
          </ThemeProvider>
        </I18nProvider>
      </ConfigProvider>
    ),
    root
  )
}
