---
name: CodeNomad Automation
description: Inspect, modify, rebuild, relaunch, and verify CodeNomad desktop builds through persistent native automation.
---

# CodeNomad Automation

Use this workflow when changing CodeNomad itself:

1. Call `codenomad.inspect` before editing. It identifies the local CodeNomad window and returns an indented accessibility outline with refs, plus runtime diagnostics. Large parts collapse with `(+N hidden)`/`(+N more)`: pass `ref` to expand one, or `query` to find elements by text or role.
2. Use refs from the latest inspections with `codenomad.act`: `click` (a real pointer click, refused when the element is covered), `type` (replaces the field's text; `clear: false` appends), `select` (native `<select>` options by label or value), `hover`, `drag` onto another ref, `scroll`, `press` a key or chord such as `Enter`, `Escape`, `Shift+Tab` or `Mod+K`, and `wait` for text to appear or disappear. Results return the field value, chosen options or focused element to check. Inspect again after navigation, reload or failed actions.
3. Make the smallest source change and run the relevant typecheck, native test, or build. The shared OpenCode daemon and this session stay alive while CodeNomad closes or relaunches.
4. After updated artifacts are ready, call `codenomad.act` with `action: "restart"`. The call gracefully relaunches the host pinned by the latest inspection, waits for the same artifact identity to reconnect to the OpenCode session, and returns a fresh inspection. It never switches to another worktree's build.
5. Call `codenomad.screenshot` for final visual evidence and report the checks that ran.

If no target is found, open this session's project in a local CodeNomad desktop window: inspection targets the focused (else most recent) local application window of the backend that owns the session. CodeNomad prepares automation at normal startup (`dev-docs/BROWSER_AUTOMATION.md`). Never install a build-specific global OpenCode plugin shim.

For Electron, rebuild before relaunching. For Windows Tauri, stop and launch the rebuilt executable manually only when the Windows linker cannot replace the running binary; the OpenCode daemon and session still persist across that gap.
