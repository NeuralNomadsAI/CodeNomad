---
name: CodeNomad Automation
description: Inspect, modify, rebuild, relaunch, and verify CodeNomad desktop builds through persistent Developer Mode.
---

# CodeNomad Automation

Use this workflow when changing CodeNomad itself:

1. Call `codenomad.inspect` before editing. It identifies the visible local CodeNomad window, verifies that this OpenCode session is the active pane, and returns accessibility refs plus runtime diagnostics.
2. Use only refs from the latest inspection with `codenomad.act`. Inspect again after navigation, reload, tab changes, or failed actions.
3. Make the smallest source change and run the relevant typecheck, native test, or build. Developer Mode does not own OpenCode: the shared `opencode2` daemon and this session remain alive if CodeNomad closes.
4. After updated artifacts are ready, call `codenomad.act` with `action: "restart"`. The call gracefully relaunches the current desktop host, waits for a new process generation to reconnect to the same OpenCode session, and returns a fresh inspection.
5. Call `codenomad.screenshot` for final visual evidence and report the checks that ran.

If no target is found, make the session visible in a local CodeNomad window, enable **Developer Mode** in the session tab bar, and restart CodeNomad. Do not use the removed Advanced Settings launcher or install a build-specific global OpenCode plugin shim.

For Electron, rebuild before relaunching. For Windows Tauri, stop and launch the rebuilt executable manually only when the Windows linker cannot replace the running binary; the OpenCode daemon and session still persist across that gap.
