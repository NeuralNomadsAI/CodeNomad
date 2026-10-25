// The real link handler and openExternalUrl in a native Tauri window; only the IPC is fake.
const calls: Array<{ command: string; args: unknown }> = []
const outcomes: Array<{ id: string; claimed: boolean }> = []
Object.assign(window, {
  __TAURI__: {},
  __CODENOMAD_WINDOW_CONTEXT__: "local",
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args: unknown) => {
      calls.push({ command, args })
    },
  },
})
const { installExternalLinkClicks } = await import("../../../src/lib/native/external-link-clicks")
installExternalLinkClicks(window)
document.body.innerHTML = `
  <a id="blank" href="https://example.com/blank" target="_blank">blank</a>
  <a id="plain" href="https://example.com/plain">plain</a>
  <a id="mail" href="mailto:hello@example.com" target="_blank">mail</a>
  <a id="tel" href="tel:+15551234567" target="_blank">tel</a>
  <a id="app" href="vscode://file/project" target="_blank">app</a>
  <a id="nested" href="https://example.com/nested" target="_blank"><span id="label">nested</span></a>`
// Registered after the handler: records whether it claimed the click, then keeps the page.
window.addEventListener("click", (event) => {
  const anchor = (event.target as Element).closest("a")
  outcomes.push({ id: anchor?.id ?? "", claimed: event.defaultPrevented })
  event.preventDefault()
})
;(window as any).fixture = { calls, outcomes }
