import { render } from "solid-js/web"
import { createSignal, For } from "solid-js"
import Button from "@suid/material/Button"
import { Info } from "lucide-solid"
import { ConfigProvider, useConfig } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider, useTheme } from "../../../src/lib/theme"
import { applyColorScheme, normalizeColorScheme, type ColorSchemeColors } from "../../../src/lib/theme-scheme"
import { Markdown } from "../../../src/components/markdown"
import { SettingsInfoTip } from "../../../src/components/settings/settings-info-tip"
import ContextMeter from "../../../src/components/context-meter"
import { MissionGraph } from "../../../src/components/mission-graph"
import "../../../src/index.css"

const tasks = [{ key: "first", blockedBy: [] }, { key: "next", blockedBy: ["first"] }] as any
function Fixture() {
  const config = useConfig(), theme = useTheme()
  const [messages, setMessages] = createSignal<Array<{ id: string; type: "text"; text: string; version: number }>>([])
  ;(window as any).contrastFixture = {
    apply: (id: string, highContrast: boolean) => applyColorScheme(normalizeColorScheme(id), { highContrast }),
    contrast: config.setHighContrastPreference,
    mode: config.setThemePreference,
    async palette(id: string) {
      const scheme = normalizeColorScheme(id)
      await config.setColorSchemePreference(scheme)
      await config.setThemePreference(scheme.appearance)
    },
    async customize(family: string, appearance: "light" | "dark", colors: ColorSchemeColors) {
      if (family === "override") await config.saveColorSchemeOverride(appearance === "light" ? "parchment" : "clay", appearance, colors)
      else if (family === "named") await config.saveColorSchemePreset("Qualification", appearance, colors)
      else await config.setColorSchemePreference({ id: "custom", appearance, colors })
      await config.setThemePreference(appearance)
    },
    saved: () => ({ scheme: config.colorSchemePreference(), presets: config.colorSchemePresets(),
      overrides: config.colorSchemeOverrides(), appearance: config.themePreference() }),
    revision: theme.themeRevision,
    loaded: config.isLoaded,
    append(count: number) {
      setMessages(previous => [...previous, ...Array.from({ length: count }, (_, i) => ({
        id: `qualification-${previous.length + i}`, type: "text" as const,
        text: `**Message ${previous.length + i}** — loaded transcript with secondary text.`, version: 0,
      }))])
    },
  }
  let list!: HTMLUListElement
  return <main style={{ padding: "24px", display: "grid", gap: "16px", "max-width": "900px" }}>
    <SettingsInfoTip text="Contrast information" />
    <Button id="mui">Material action</Button>
    <Button id="mui-disabled" disabled>Disabled material action</Button>
    <input id="field" class="form-input" placeholder="Placeholder" />
    <input id="disabled-field" class="form-input" disabled value="Disabled field" />
    <textarea id="composer" class="prompt-input shell-mode" placeholder="Composer placeholder" />
    <button id="secondary" class="button-secondary">Secondary action</button>
    <button id="disabled-action" class="button-secondary" disabled>Disabled action</button>
    <button id="tool-disabled" class="tool-call-header-icon-button" disabled><Info /></button>
    <button id="search-disabled" class="message-search-button" disabled><Info /></button>
    <button id="rail" class="session-scroll-corner-button session-scroll-corner-button--reached"><Info /></button>
    <div class="right-panel-empty"><span class="right-panel-empty-text">Empty panel</span></div>
    <div class="git-panel"><span class="git-panel-count">3 changes</span><div class="git-panel-file"><small>Modified</small></div></div>
    <div class="mission-scheduling"><fieldset disabled><fieldset disabled><span id="nested-disabled" class="text-muted">Disabled schedule</span></fieldset></fieldset></div>
    <ContextMeter usedTokens={100} availableTokens={1000} formatTokens={String} usedLabel="Used" availableLabel="Available" />
    <div style={{ position: "relative" }}>
      <ul ref={list}><For each={tasks}>{(task: any) =>
        <li data-task-key={task.key} style={{ padding: "8px 40px" }}><span data-graph-anchor>{task.key}</span></li>
      }</For></ul>
      <MissionGraph tasks={tasks} list={list} />
    </div>
    <span id="secondary-text" class="text-secondary">Secondary text</span>
    <span id="muted-text" class="text-muted">Muted text</span>
    <span id="accent-text" class="text-accent">Accent text</span>
    <span id="search-match" class="session-search-match">Search match</span>
    <span id="search-active" class="session-search-match session-search-match-active">Active match</span>
    <span id="native-selection">Selected text</span>
    <div class="message-item-base"><div class="message-item-actions"><button class="message-action-button" disabled>Hidden action</button></div></div>
    <div class="tool-call-header"><button id="hidden-copy" class="tool-call-header-icon-button tool-call-header-copy">Hidden copy</button></div>
    <div class="message-technical-group-header"><button id="hidden-technical" class="tool-call-header-icon-button" disabled>Hidden technical action</button></div>
    <span id="hidden-zero" class="opacity-0">Hidden</span>
    <span id="hidden-inline" class="text-muted" style={{ opacity: 0 }}>Hidden inline</span>
    <button id="hidden-delete" class="window-icon-button toast-history-item-delete" disabled>Hidden delete</button>
    <button id="hidden-stage" class="window-icon-button git-panel-file-stage" disabled>Hidden stage</button>
    <span id="ansi-hidden" style={{ visibility: "hidden" }}>Hidden ANSI</span>
    <section id="loaded-transcript"><For each={messages()}>{part =>
      <article data-message-id={part.id} class="message-item-base">
        <Markdown part={part} instanceId="contrast" sessionId="loaded" isDark={theme.isDark()} disableHighlight />
      </article>
    }</For></section>
  </main>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>,
  document.getElementById("root")!)
