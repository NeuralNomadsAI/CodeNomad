import { For, Show, createEffect, createMemo, createUniqueId } from "solid-js"
import { Split } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import type { SessionSearchMatch } from "../lib/session-search"
import { createHistorySessionLabels, type HistorySessionLabel } from "../stores/history-search-sessions"
import { getGitRepoStatus, getWorktreeForDirectory } from "../stores/worktrees"

type HistorySearchMatch = SessionSearchMatch & { sessionId: string }

/**
 * Workspace results are grouped by consecutive session: each group names its
 * conversation and current worktree/branch, so a hit identifies its task.
 */
export default function HistorySearchResults(props: {
  instanceId: string
  matches: HistorySearchMatch[]
  activeIndex: number
  showSessions: boolean
  onSelect: (index: number) => void
}) {
  const { t } = useI18n()
  const id = createUniqueId()
  const labels = createHistorySessionLabels(() => props.instanceId)
  createEffect(() => {
    if (props.showSessions) labels.request(props.matches.map(match => match.sessionId))
    else labels.cancel()
  })
  const groupStarts = createMemo(() => {
    let start = 0
    return props.matches.map((match, index) => index > 0 && props.matches[index - 1]!.sessionId === match.sessionId ? start : (start = index))
  })
  return <div class="history-search-results">
    <For each={props.matches}>{(match, index) => <>
      <Show when={props.showSessions && groupStarts()[index()] === index()}>
        <HistorySearchSession id={`${id}-${index()}`} instanceId={props.instanceId} label={labels.get(match.sessionId)} />
      </Show>
      <button type="button" class="history-search-result" classList={{ "history-search-result-active": props.activeIndex === index() }}
        aria-describedby={props.showSessions ? `${id}-${groupStarts()[index()]}` : undefined} onClick={() => props.onSelect(index())}>
        <span class="text-xs text-muted">{t(`history.${match.partType}`)}</span>
        <span>{match.preview}</span>
      </button>
    </>}</For>
  </div>
}

export function HistoryWorktreeBadge(props: { instanceId: string; directory?: string }) {
  const { t } = useI18n()
  // Current location: a session moved since the message was written reports its new worktree.
  const worktree = () => props.directory && getGitRepoStatus(props.instanceId) === true
    ? getWorktreeForDirectory(props.instanceId, props.directory) : undefined
  return <Show when={worktree()}>{entry => {
    const label = () => entry().label ?? entry().slug
    return <span class="history-search-worktree badge-shape" title={t("sessionList.worktree.tooltip", { worktree: label() })}>
      <Split class="w-3 h-3" aria-hidden="true" />
      <span class="history-search-worktree-label">{label()}</span>
    </span>
  }}</Show>
}

function HistorySearchSession(props: { id: string; instanceId: string; label: HistorySessionLabel | null | undefined }) {
  const { t } = useI18n()
  const title = () => props.label === null ? t("history.sessionUnavailable") : props.label?.title || t("sessionList.session.untitled")
  return <div id={props.id} class="history-search-session" aria-busy={props.label === undefined}>
    <span class="history-search-session-title" classList={{ "text-muted": !props.label }}>{props.label === undefined ? "" : title()}</span>
    <HistoryWorktreeBadge instanceId={props.instanceId} directory={props.label?.directory} />
  </div>
}
