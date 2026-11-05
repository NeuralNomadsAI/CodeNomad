import { createMemo, type Accessor } from "solid-js"
import { instances } from "../stores/instances"
import { captureSessionRequestAuthority } from "../stores/session-api"
import { messageStoreBus } from "../stores/message-v2/bus"
import { parseSessionMediaPath } from "../../../server/src/opencode/session-media-contract"
import { isToolImageContent } from "./tool-content"
import { restrictedMediaPolicy, trustedMediaPolicy, type MediaPolicy } from "./media-policy"
import { normalizeLocalProjectPath } from "./project-identity"

/** Content ownership comes from the rendering caller, independently of the selected tab. */
export function createContentMediaPolicy(instanceId: Accessor<string | undefined>, sessionId: Accessor<string | undefined>, unowned: MediaPolicy = trustedMediaPolicy): Accessor<MediaPolicy> {
  let contentOwner: { id: string; session?: string; server: string; directory: string; folder: string } | undefined
  const authority = createMemo(() => {
    const id = instanceId(), session = sessionId()
    const instance = id ? instances().get(id) : undefined
    // Observe both the occurrence and its connection before taking a fresh capture.
    instance?.client; instance?.binding; instance?.capabilities?.generation
    return id && session && instance ? captureSessionRequestAuthority(id, session) : () => false
  })
  return createMemo<MediaPolicy>(() => {
    const id = instanceId(), session = sessionId()
    if (!id) return unowned
    const instance = instances().get(id)
    if (!instance) return restrictedMediaPolicy
    const owner = { id, session, server: instance.binding?.serverId ?? "local-shared", directory: instance.binding?.directory ?? instance.folder, folder: instance.folder }
    if (owner.server === "local-shared") {
      owner.directory = normalizeLocalProjectPath(owner.directory)
      owner.folder = normalizeLocalProjectPath(owner.folder)
    }
    const ownerKey = JSON.stringify([id, session, owner.server, owner.directory, owner.folder])
    const captured = instance.renderBinding
    const origin = captured?.serverId === "local-shared" ? { ...captured,
      directory: normalizeLocalProjectPath(captured.directory), folder: normalizeLocalProjectPath(captured.folder),
    } : captured
    if (origin && (origin.serverId !== owner.server || origin.directory !== owner.directory || origin.folder !== owner.folder)) {
      return { ...restrictedMediaPolicy, ownerKey: JSON.stringify([id, session, origin.serverId, origin.directory, origin.folder]) }
    }
    if (!contentOwner || contentOwner.id !== id || contentOwner.session !== session) contentOwner = owner
    // A reused occurrence's cached parts retain their original binding until remounted.
    if (contentOwner.server !== owner.server || contentOwner.directory !== owner.directory || contentOwner.folder !== owner.folder) return { ...restrictedMediaPolicy, ownerKey }
    if (!instance.binding || instance.binding.serverId === "local-shared") return { kind: "local", ownerKey }
    const current = authority()() && instance.capabilities?.features?.media?.state === "available"
    const nativeMedia: { uri: string; mime: string }[] = []
    if (session && current) {
      const store = messageStoreBus.getOrCreate(id)
      for (const messageId of store.getSessionMessageIds(session)) {
        const message = store.getMessage(messageId)
        if (!message || message.sessionId !== session) continue
        message.partIds.forEach((partId, part) => {
          const data = message.parts[partId]?.data
          if (data?.type !== "tool" || data.state?.status !== "completed" || !Array.isArray(data.state.content)) return
          data.state.content.forEach((file, index) => {
            if (!isToolImageContent(file)) return
            const ref = parseSessionMediaPath(file.uri)
            if (ref?.workspaceId === id && ref.sessionId === session && ref.messageId === messageId && ref.part === part && ref.index === index) nativeMedia.push({ uri: file.uri, mime: file.mime })
          })
        })
      }
    }
    return { kind: "explicit", instanceId: id, sessionId: session, current, nativeMedia, ownerKey }
  })
}
