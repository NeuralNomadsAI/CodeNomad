import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import EnvironmentVariablesEditor from "../../../src/components/environment-variables-editor"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

let server = { environmentVariables: { FIXTURE_KEY: "original" } as Record<string, string>, secureEnvVars: [] }
const writes: unknown[] = []
serverApi.fetchConfigOwner = async <T extends Record<string, unknown>>(owner: string): Promise<T> =>
  (owner === "server" ? server : {}) as unknown as T
await applyUiSettings({ locale: "en" })
serverApi.patchConfigOwner = async <T extends Record<string, unknown>>(owner: string, patch: unknown): Promise<T> => {
  if (owner !== "server") throw new Error("Unexpected fixture write")
  writes.push(structuredClone(patch))
  const next = patch as Partial<typeof server>
  const variables = { ...server.environmentVariables, ...next.environmentVariables }
  for (const key of Object.keys(variables)) if (variables[key] === null) delete variables[key]
  server = { ...server, ...next, environmentVariables: variables }
  return server as unknown as T
}
const [disabled, setDisabled] = createSignal(false)
;(window as any).fixture = { writes, setDisabled }
render(() => <ConfigProvider><I18nProvider>
  <EnvironmentVariablesEditor disabled={disabled()} bare />
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
