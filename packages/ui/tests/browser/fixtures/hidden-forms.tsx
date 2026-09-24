import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { FormAnswer, FormFields, FormInfo } from "@opencode/client"
import FormRequest from "../../../src/components/form-request"
import { ProviderAuthForm } from "../../../src/components/provider-auth/provider-auth-form"
import { getProviderAuthAnswer, getProviderAuthInitialAnswer } from "../../../src/lib/provider-auth"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"

const fields: FormFields = [
  { key: "name", type: "string", title: "Name", required: true },
  { key: "tenant", type: "string", title: "Hidden tenant", hidden: true, required: true, default: "native-tenant" },
  { key: "flag", type: "boolean", title: "Hidden flag", hidden: true, default: false },
  { key: "unset", type: "boolean", hidden: true },
  { key: "inactive", type: "string", hidden: true, default: "omit", when: [{ key: "name", op: "eq", value: "other" }] },
]
const replies: FormAnswer[] = [], authReplies: Array<FormAnswer | undefined> = []
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.patchConfigOwner = async (_owner, patch) => patch as any
function Fixture() {
  const [answer, setAnswer] = createSignal(getProviderAuthInitialAnswer(fields))
  return <ConfigProvider><I18nProvider><main style={{ width: "600px", padding: "24px" }}>
    <FormRequest form={{ id: "form", sessionID: "s", title: "Session form", fields, state: { status: "pending" } } as FormInfo}
      onReply={async value => { replies.push(value) }} onCancel={async () => {}} />
    <form aria-label="Provider form" onSubmit={event => {
      event.preventDefault()
      authReplies.push(getProviderAuthAnswer(fields, answer()))
    }}>
      <ProviderAuthForm fields={fields} answer={answer()} onAnswer={(key, value) => setAnswer(previous => ({ ...previous, [key]: value }) as FormAnswer)} />
      <button type="submit">Connect fixture</button>
    </form>
  </main></I18nProvider></ConfigProvider>
}
render(() => <Fixture />, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = { replies, authReplies }
