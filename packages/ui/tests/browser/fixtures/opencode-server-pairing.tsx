// prototype-1236: Add server recognises an `opencode pair` link and hands it to the host backend.
import { serverApi } from "../../../src/lib/api-client"
import { render } from "solid-js/web"
import { RemoteServerDialog } from "../../../src/components/remote-server-dialog"
import { useRemoteServerProfiles } from "../../../src/lib/hooks/use-remote-server-profiles"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import "../../../src/index.css"

const fixture = window as unknown as { added: Array<{ name?: string; address: string }>; fetched: string[]; uiState: () => string }
fixture.added = []
fixture.fetched = []
let uiBucket: Record<string, unknown> = {}
fixture.uiState = () => JSON.stringify(uiBucket)
// Any request the page itself makes to the link would consume its single-use code.
const nativeFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  fixture.fetched.push(String(input instanceof Request ? input.url : input))
  return nativeFetch(input, init)
}

serverApi.fetchConfigOwner = (async () => ({})) as typeof serverApi.fetchConfigOwner
serverApi.fetchStateOwner = (async (owner: string) => (owner === "ui" ? uiBucket : {})) as typeof serverApi.fetchStateOwner
serverApi.patchStateOwner = (async (owner: string, patch: unknown) => {
  if (owner === "ui") uiBucket = { ...uiBucket, ...(patch as Record<string, unknown>) }
  return uiBucket
}) as typeof serverApi.patchStateOwner
serverApi.probeRemoteServer = async () => { throw new Error("an OpenCode link must not be probed as a CodeNomad server") }
serverApi.addOpenCodeServer = async (payload) => {
  fixture.added.push(payload)
  if (payload.address.endsWith("/expired-code")) throw new Error("pairing_expired")
  return { id: "oc-1", label: payload.name ?? "", origin: new URL(payload.address).origin }
}

const Harness = () => {
  const { saveServer } = useRemoteServerProfiles()
  return <main style={{ width: "min(900px, 100%)" }}><RemoteServerDialog open onOpenChange={() => undefined} onSubmit={saveServer} /></main>
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider><Harness /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
