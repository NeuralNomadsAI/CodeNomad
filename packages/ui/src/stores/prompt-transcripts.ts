import { createStore, reconcile } from "solid-js/store"
import { onInstanceLifecycleAuthority } from "./instance-lifecycle-authority"

type Transcript = { text: string; directory: string; owner: () => boolean }
const [transcripts, setTranscripts] = createStore<Record<string, Record<string, Transcript | undefined> | undefined>>({})
const key = (id: string) => `:${id}`

export const promptTranscript = (instanceId: string, sessionId: string) => transcripts[key(instanceId)]?.[key(sessionId)]

export function setPromptTranscript(instanceId: string, sessionId: string, value: Transcript | undefined) {
  const instance = key(instanceId), session = key(sessionId)
  if (!transcripts[instance]) {
    if (value) setTranscripts(instance, { [session]: value })
  } else {
    setTranscripts(instance, session, () => value)
  }
}

onInstanceLifecycleAuthority(event => setTranscripts(key(event.instanceId), undefined))
if (typeof window !== "undefined") window.addEventListener("pagehide", () => setTranscripts(reconcile({})))
