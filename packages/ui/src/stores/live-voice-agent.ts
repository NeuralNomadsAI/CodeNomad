import type { LiveVoiceContext, LiveVoiceSessionStatus, LiveVoiceTool } from "../../../server/src/speech/live-voice-contract"
import { resolvePromptDelivery } from "../components/prompt-input/submitPrompt"
import { getInstanceLabel } from "../lib/instance-label"
import { partHasRenderableText } from "../types/message"
import { activeInstanceId, instances } from "./instances"
import { messageStoreBus } from "./message-v2/bus"
import { MESSAGE_WINDOW_PAGE_SIZE } from "./message-v2/message-window"
import type { FollowUpBehavior } from "./preferences"
import { locationAuthorityKey } from "./request-locations"
import { sendMessage } from "./session-actions"
import { isLatestMessageWindow, loadLatestMessageWindow } from "./session-api"
import { normalizeSessionDirectory } from "./session-list-options"
import { activeSessionId, sessions } from "./session-state"
import { isSessionBusy } from "./session-status"
import { getWorktrees } from "./worktrees"
import { sessionPromptAwaitingExecution } from "./session-prompt-ack"
import { getRootClient } from "./opencode-client"
import { normalizeSessionMessage } from "./message-v2/normalizers"

const title = (label: string | undefined) => (label ?? "").slice(0, 256)
const VOICE_UNDO_SEEK_PAGES = 8

export function liveVoiceTargetSession(instanceId: string, sessionId: string | undefined) {
  if (!sessionId || activeInstanceId() !== instanceId || activeSessionId().get(instanceId) !== sessionId) return
  return nativeVoiceTarget(instanceId, sessionId)
}

function nativeVoiceTarget(instanceId: string, sessionId: string) {
  const instance = instances().get(instanceId)
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!instance?.client || instance.status !== "ready" || !session?.location.directory || session.catalogSnapshot) return
  return { instance, session, key: JSON.stringify([instance.id, instance.folder, instance.proxyPath, sessionId, locationAuthorityKey(session.location)]) }
}

type Target = NonNullable<ReturnType<typeof liveVoiceTargetSession>>

function sessionStatus(instanceId: string, sessionId: string) {
  const session = sessions().get(instanceId)?.get(sessionId)
  const status: LiveVoiceSessionStatus = session?.pendingPermission ? "waiting_permission"
    : session?.pendingForm ? "waiting_question" : isSessionBusy(instanceId, sessionId) ? "running" : "idle"
  return { title: title(session?.title), status }
}

export function liveVoiceContext({ instance, session }: Target): LiveVoiceContext {
  const directory = normalizeSessionDirectory(session.location.directory)
  const tree = getWorktrees(instance.id).flatMap(entry => [entry.directory, entry.serviceDirectory].flatMap(path => {
    const root = normalizeSessionDirectory(path)
    return root && (root === directory || (!entry.directoryOnly && directory.startsWith(`${root.replace(/\/$/, "")}/`)))
      ? [{ entry, root }] : []
  })).sort((a, b) => b.root.length - a.root.length)[0]?.entry
  return {
    project: title(getInstanceLabel(instance)),
    branch: title(tree?.branch),
    worktree: title(tree?.label ?? tree?.slug),
    ...sessionStatus(instance.id, session.id),
  }
}

export function liveVoiceAgent({ instance, session }: Target, options: {
  followUp: () => FollowUpBehavior
  canSend: () => boolean
}) {
  const instanceId = instance.id
  const sessionId = session.id
  async function recentAssistant(current: () => boolean) {
    if (!isLatestMessageWindow(instanceId, sessionId)) {
      const client = getRootClient(instanceId)
      const revertBoundary = () => sessions().get(instanceId)?.get(sessionId)?.revert?.messageID
      const boundary = revertBoundary()
      let page = await client.message.list({
        sessionID: sessionId, limit: MESSAGE_WINDOW_PAGE_SIZE, order: "desc",
      })
      const seen = new Set<string>()
      while (current() && revertBoundary() === boundary && boundary && page.data.length
        && page.data.every(raw => raw.id >= boundary)) {
        const cursor = page.cursor?.next
        if (!cursor || seen.has(cursor) || seen.size >= VOICE_UNDO_SEEK_PAGES - 1) break
        seen.add(cursor)
        page = await client.message.list({ sessionID: sessionId, limit: MESSAGE_WINDOW_PAGE_SIZE, cursor })
      }
      if (!current() || revertBoundary() !== boundary) return
      return page.data.flatMap(raw => {
        if (boundary && raw.id >= boundary) return []
        const { message, info } = normalizeSessionMessage(sessionId, raw)
        return info.role === "assistant" && info.nativeType !== "system" ? [{ parts: message.parts, info }] : []
      })
    }
    const store = messageStoreBus.getInstance(instanceId)
    if (!store) return []
    const ids = store.getSessionMessageIds(sessionId).slice(-MESSAGE_WINDOW_PAGE_SIZE).reverse()
    return ids.flatMap(id => {
      const row = store.getMessage(id)
      const info = store.getMessageInfo(id)
      if (row?.role === "assistant" && !row.isEphemeral && info?.nativeType !== "system") {
        return [{ parts: row.partIds.map(partId => row.parts[partId]?.data), info }]
      }
      return []
    })
  }
  return async (tool: LiveVoiceTool, current: () => boolean) => {
    if (!current()) return { error: "The conversation has changed." }
    switch (tool.name) {
      case "get_session_status":
        return sessionStatus(instanceId, sessionId)
      case "get_last_reply": {
        const recent = await recentAssistant(current)
        if (!recent || !current()) return { error: "The conversation has changed." }
        for (const { parts } of recent) {
          let text = ""
          for (const part of parts) {
            if (part?.type !== "text" || !partHasRenderableText(part)) continue
            const remaining = 2000 - text.length
            text += `${text ? "\n\n" : ""}${part.text.slice(0, remaining)}`.slice(0, remaining)
            if (text.length === 2000) break
          }
          if (text) return { text }
        }
        return { text: "" }
      }
      case "get_recent_errors": {
        const recent = await recentAssistant(current)
        if (!recent || !current()) return { error: "The conversation has changed." }
        const retry = sessions().get(instanceId)?.get(sessionId)?.retry?.message
        const errors = [retry, ...recent.map(({ info }) => info?.error?.data?.message ?? info?.error?.message)]
        return { errors: [...new Set(errors.filter((error): error is string => typeof error === "string" && error.trim().length > 0))]
          .slice(0, 3).map(error => error.slice(0, 500)) }
      }
      case "send_to_agent": {
        const admissionCurrent = () => current() && options.canSend()
        if (!admissionCurrent()) return { error: "This conversation cannot accept a message now." }
        const latest = () => isLatestMessageWindow(instanceId, sessionId)
        let delivery: "queue" | "steer" | undefined
        await sendMessage(instanceId, sessionId, tool.arguments.text.trim(), [], {
          prepareAdmission: async () => {
            if (admissionCurrent() && !latest()) await loadLatestMessageWindow(instanceId, sessionId)
          },
          admissionCurrent: () => admissionCurrent() && latest(),
          delivery: () => delivery = resolvePromptDelivery(
            sessionPromptAwaitingExecution(instanceId, sessionId) || isSessionBusy(instanceId, sessionId),
            options.followUp(),
          ),
        })
        return { delivery: delivery === "queue" ? "queued" : "submitted" }
      }
    }
  }
}
