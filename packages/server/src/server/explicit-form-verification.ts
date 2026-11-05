import { OpenCode } from "@opencode/client"
import { z } from "zod"
import { boundedResponseFetch } from "../opencode/bounded-response-fetch"
import { wireFormSchema } from "../opencode/form-contract"
import { FORM_VERIFICATION_LIMIT } from "../opencode/form-verification-policy"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { waitForAdmission } from "./request-admission"

const location = z.object({ directory: z.string(), workspaceID: z.string().optional() })
const sessionEnvelope = z.object({ data: z.object({ id: z.string(), location }) })
const formEnvelope = z.object({ data: wireFormSchema, location: location.optional() })

/** One admitted native GET. Every body is bounded and validated before the SDK sees it. */
export async function readExplicitForm(args: {
  acquire: () => Promise<ServiceConnection | undefined>
  current: () => void
  signal: AbortSignal
  sessionId: string
  formId: string
  directory: string
}) {
  const { signal, sessionId, formId, directory } = args
  const wait = <T>(pending: Promise<T>) => waitForAdmission(pending, signal)
  const current = () => { signal.throwIfAborted(); args.current(); connection?.assertCurrent() }
  let connection: ServiceConnection | undefined
  current()
  connection = await wait(args.acquire())
  current()
  if (!connection) throw new Error("Form verification unavailable")
  await wait(connection.profile(signal))
  current()
  const transport = boundedResponseFetch(connection.fetch, signal, current, FORM_VERIFICATION_LIMIT)
  const client = OpenCode.make({ baseUrl: connection.endpoint.url, fetch: async (input, init) => {
    current()
    const response = await wait(transport(input, init))
    current()
    // All error statuses, including native absence, remain indeterminate. The wire
    // body never becomes an SDK Error whose inherited message could supply proof.
    if (response.status !== 200 || !/^application\/json\s*(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("Invalid Form verification response")
    const value: unknown = JSON.parse(await wait(response.text()), (_key, item) => {
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Invalid JSON number")
      return item
    })
    current()
    const path = new URL(input instanceof Request ? input.url : input).pathname
    if (path.endsWith(`/form/${formId}`)) {
      const parsed = formEnvelope.safeParse(value)
      if (!parsed.success || parsed.data.data.id !== formId || parsed.data.data.sessionID !== sessionId
        || (parsed.data.location && (parsed.data.location.directory !== directory || parsed.data.location.workspaceID !== undefined))) throw new Error("Invalid Form identity or state")
      const form = parsed.data.data
      // Validate the complete native answer, then discard it before publication.
      return Response.json({ data: { ...form, state: { status: form.state.status } } })
    }
    const parsed = sessionEnvelope.safeParse(value)
    if (!parsed.success || parsed.data.data.id !== sessionId || parsed.data.data.location.directory !== directory
      || parsed.data.data.location.workspaceID !== undefined) throw new Error("Invalid Form session placement")
    return Response.json(parsed.data)
  } })
  const session = async () => {
    current()
    if (sessionId !== "global") await wait(client.session.get({ sessionID: sessionId }, { signal }))
    current()
  }
  await session()
  const result = await wait(client.session.form.get({ sessionID: sessionId, formID: formId }, {
    signal, ...(sessionId === "global" ? { headers: { "x-opencode-directory": encodeURIComponent(directory) } } : {}),
  }))
  current()
  await session()
  current()
  return { data: result }
}
