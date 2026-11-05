import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { SessionInboxUser, SessionInboxUserPayload } from "@opencode/client"
import { createAgentAttachment, createFileAttachment, createSkillAttachment, type Attachment } from "../../types/attachment"
import { instances } from "../../stores/instances"
import { onInstanceLifecycleAuthority } from "../../stores/instance-lifecycle-authority"

export interface QueuedPromptDraft {
  id: string
  text: string
  payload: SessionInboxUserPayload
  attachments: Attachment[]
}

export function queuedPromptDraft(item: SessionInboxUser): QueuedPromptDraft {
  const displayText = item.payload.metadata?.displayText
  return {
    id: item.id,
    text: typeof displayText === "string" && displayText ? displayText : item.payload.text,
    payload: item.payload,
    attachments: [
      ...(item.payload.files ?? []).map(file => {
        const uri = file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`
        const name = file.name ?? file.mention?.text.replace(/^@/, "") ?? file.mime
        const attachment = createFileAttachment(uri, name, file.mime)
        if (file.mention?.text) attachment.display = file.mention.text
        return attachment
      }),
      ...(item.payload.agents ?? []).map(agent => createAgentAttachment(agent.name)),
      ...(item.payload.skills ?? []).map(skill => createSkillAttachment(skill.id, skill.name)),
    ],
  }
}

/** View-local recovery uses the existing draft/attachment stores when explicitly restored. */
export function usePromptRecovery(instanceId: Accessor<string>, sessionId: Accessor<string>) {
  type Source = { instanceId: string; sessionId: string; folder?: string; serverId?: string; directory?: string; epoch?: object }
  const epochs = new Map<string, object>()
  const [feedback, setFeedback] = createSignal<Source[]>([])
  const [queued, setQueued] = createSignal<Array<Source & { draft: QueuedPromptDraft }>>([])
  let disposed = false
  const same = (a: Source, b: Source) => a.instanceId === b.instanceId && a.sessionId === b.sessionId
  const held = (source: Source) => {
    const live = instances().get(source.instanceId)
    return !disposed && Boolean(live) && epochs.get(source.instanceId) === source.epoch
      && live?.folder === source.folder && live?.binding?.serverId === source.serverId && live?.binding?.directory === source.directory
  }
  const shown = (source: Source) => held(source) && source.instanceId === instanceId() && source.sessionId === sessionId()
  const stop = onInstanceLifecycleAuthority(event => {
    if (event.type === "opened") return
    epochs.set(event.instanceId, {})
    setFeedback(previous => previous.filter(source => source.instanceId !== event.instanceId))
    setQueued(previous => previous.filter(source => source.instanceId !== event.instanceId))
  })
  onCleanup(() => { disposed = true; stop() })
  function capture() {
    const id = instanceId(), live = instances().get(id)
    const source: Source = { instanceId: id, sessionId: sessionId(), folder: live?.folder,
      serverId: live?.binding?.serverId, directory: live?.binding?.directory, epoch: epochs.get(id) }
    return {
      current: () => held(source),
      showFeedback: () => {
        if (held(source)) setFeedback(previous => previous.some(item => same(item, source)) ? previous : [...previous, source])
      },
      recoverQueuedPrompt: (draft: QueuedPromptDraft) => {
        if (held(source)) setQueued(previous => [...previous.filter(item => !same(item, source) || item.draft.id !== draft.id), { ...source, draft }])
      },
    }
  }
  return {
    capture,
    feedback: () => feedback().some(shown),
    queued: () => queued().filter(shown).map(item => item.draft),
    clearFeedback: () => setFeedback(previous => previous.filter(source => !shown(source))),
    forgetQueued: (id: string) => setQueued(previous => previous.filter(source => !shown(source) || source.draft.id !== id)),
  }
}
