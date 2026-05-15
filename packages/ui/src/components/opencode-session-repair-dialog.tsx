import { Dialog } from "@kobalte/core/dialog"
import { For, Show, createMemo, type Component } from "solid-js"

import { useI18n } from "../lib/i18n"
import {
  applyOpenCodeSessionRepair,
  closeOpenCodeSessionRepairDialog,
  openCodeSessionRepairDialogState,
  openOpenCodeSessionRepairDialogState,
} from "../stores/opencode-session-repair"

const OpencodeSessionRepairDialog: Component = () => {
  const { t } = useI18n()

  const analysis = createMemo(() => openCodeSessionRepairDialogState().analysis)
  const result = createMemo(() => openCodeSessionRepairDialogState().result)
  const importantIssueCount = createMemo(() => {
    const issues = analysis()?.issues
    if (!issues) return 0
    return issues.sessionsLikelyBroken + issues.sessionsLikelyHidden
  })
  const highlightedSessions = createMemo(() =>
    (analysis()?.affectedSessions ?? []).filter((session) => session.likelyBroken || session.likelyHidden),
  )
  const canRepairImportantIssues = createMemo(() => importantIssueCount() > 0)
  const canNormalizeRemainingMetadata = createMemo(() => {
    const issues = analysis()?.issues
    if (!issues) return false
    return issues.sessionsWithIncompleteMetadataOnly > 0 && issues.sessionsWithRepairableSafeMetadata > 0
  })

  return (
    <Dialog
      open={openOpenCodeSessionRepairDialogState()}
      modal
      onOpenChange={(next) => {
        if (!next) closeOpenCodeSessionRepairDialog()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay z-[60]" />
        <Dialog.Content class="modal-surface fixed left-1/2 top-1/2 z-[1310] w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 p-6 border border-base shadow-2xl" tabIndex={-1}>
          <div>
            <Dialog.Title class="text-lg font-semibold text-primary">{t("commands.repairOpenCodeSessions.dialog.title")}</Dialog.Title>
            <Dialog.Description class="text-sm text-secondary mt-1">
              {t("commands.repairOpenCodeSessions.dialog.description")}
            </Dialog.Description>
          </div>

          <div class="mt-6 space-y-4" aria-busy={openCodeSessionRepairDialogState().loading || openCodeSessionRepairDialogState().applying}>
            <Show when={openCodeSessionRepairDialogState().loading}>
              <div class="rounded-xl border border-base bg-[var(--surface-subtle)] p-4 text-sm text-secondary">
                {t("commands.repairOpenCodeSessions.status.analyzing")}
              </div>
            </Show>

            <Show when={openCodeSessionRepairDialogState().error}>
              {(error) => (
                <div class="rounded-xl border border-[var(--status-error)] bg-[var(--danger-soft-bg)] p-4 text-sm text-primary whitespace-pre-wrap">
                  {error()}
                </div>
              )}
            </Show>

            <Show when={analysis()}>
              {(report) => (
                <>
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <SummaryCard label={t("commands.repairOpenCodeSessions.summary.sessions")} value={String(report().sessionCount)} />
                    <SummaryCard label={t("commands.repairOpenCodeSessions.summary.likelyBroken")} value={String(report().issues.sessionsLikelyBroken)} />
                    <SummaryCard label={t("commands.repairOpenCodeSessions.summary.likelyHidden")} value={String(report().issues.sessionsLikelyHidden)} />
                    <SummaryCard label={t("commands.repairOpenCodeSessions.summary.incompleteOnly")} value={String(report().issues.sessionsWithIncompleteMetadataOnly)} />
                    <SummaryCard label={t("commands.repairOpenCodeSessions.summary.missingMessageAgent")} value={String(report().issues.sessionsWithMissingAssistantAgentMessages)} />
                    <SummaryCard label={t("commands.repairOpenCodeSessions.summary.directoryRepairs")} value={String(report().issues.sessionsWithRecommendedDirectoryRepair)} />
                  </div>

                  <Show when={highlightedSessions().length > 0} fallback={<div class="rounded-xl border border-base bg-[var(--surface-subtle)] p-4 text-sm text-secondary">{t("commands.repairOpenCodeSessions.report.noHighlightedIssues", { count: report().issues.sessionsWithIncompleteMetadataOnly })}</div>}>
                    <div class="rounded-xl border border-base">
                      <div class="border-b border-base px-4 py-3 text-sm font-medium text-primary">
                        {t("commands.repairOpenCodeSessions.report.highlightedSessions")}
                      </div>
                      <div class="max-h-64 overflow-y-auto px-4 py-3 space-y-3">
                        <For each={highlightedSessions().slice(0, 25)}>
                          {(session) => (
                            <div class="rounded-lg border border-base px-3 py-2">
                              <div class="text-sm font-medium text-primary break-words">{session.title || session.id}</div>
                              <div class="text-xs text-secondary break-all mt-1">{session.id}</div>
                              <div class="text-xs text-secondary break-all">{session.directory}</div>
                              <div class="mt-2 flex flex-wrap gap-2 text-[11px]">
                                <Show when={session.likelyBroken}><IssueBadge>{t("commands.repairOpenCodeSessions.badge.likelyBroken")}</IssueBadge></Show>
                                <Show when={session.likelyHidden}><IssueBadge>{t("commands.repairOpenCodeSessions.badge.likelyHidden")}</IssueBadge></Show>
                                <Show when={session.missingAssistantAgentMessages > 0}>
                                  <IssueBadge>{t("commands.repairOpenCodeSessions.badge.missingMessageAgent", { count: session.missingAssistantAgentMessages })}</IssueBadge>
                                </Show>
                                <Show when={session.recommendedDirectory}><IssueBadge>{t("commands.repairOpenCodeSessions.badge.directoryRepair")}</IssueBadge></Show>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  <Show when={report().issues.sessionsWithIncompleteMetadataOnly > 0}>
                    <div class="rounded-xl border border-base bg-[var(--surface-subtle)] p-4 text-sm text-secondary">
                      {t("commands.repairOpenCodeSessions.report.incompleteOnlyNote", {
                        count: report().issues.sessionsWithIncompleteMetadataOnly,
                        nonRepairable: report().issues.sessionsWithRemainingIncompleteMetadata,
                      })}
                    </div>
                  </Show>
                </>
              )}
            </Show>

            <Show when={result()}>
              {(repairResult) => (
                <div class="rounded-xl border border-[var(--status-success)] bg-[var(--badge-success-bg)] p-4 text-sm text-primary whitespace-pre-wrap">
                  <div>{t("commands.repairOpenCodeSessions.result.success")}</div>
                  <div class="mt-2 text-secondary">{t("commands.repairOpenCodeSessions.result.mode", { mode: repairResult().mode })}</div>
                  <div class="mt-2 text-secondary">{t("commands.repairOpenCodeSessions.result.backup", { path: repairResult().backupPath })}</div>
                </div>
              )}
            </Show>
          </div>

          <div class="mt-6 flex flex-wrap justify-end gap-3">
            <button type="button" class="button-secondary" disabled={!canNormalizeRemainingMetadata() || openCodeSessionRepairDialogState().loading || openCodeSessionRepairDialogState().applying} onClick={() => void applyOpenCodeSessionRepair("normalize")}>
              {t("commands.repairOpenCodeSessions.actions.normalizeRemaining")}
            </button>
            <button type="button" class="button-primary" disabled={!canRepairImportantIssues() || openCodeSessionRepairDialogState().loading || openCodeSessionRepairDialogState().applying} onClick={() => void applyOpenCodeSessionRepair("important")}>
              {openCodeSessionRepairDialogState().applying ? t("commands.repairOpenCodeSessions.actions.applying") : t("commands.repairOpenCodeSessions.actions.repairImportant")}
            </button>
            <button type="button" class="button-secondary" disabled={openCodeSessionRepairDialogState().applying} onClick={closeOpenCodeSessionRepairDialog}>
              {t("commands.repairOpenCodeSessions.actions.close")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}

const SummaryCard: Component<{ label: string; value: string }> = (props) => (
  <div class="rounded-xl border border-base bg-[var(--surface-subtle)] p-4">
    <div class="text-xs uppercase tracking-wide text-secondary">{props.label}</div>
    <div class="mt-2 text-2xl font-semibold text-primary">{props.value}</div>
  </div>
)

const IssueBadge: Component<{ children: any }> = (props) => (
  <span class="rounded-full border border-base bg-[var(--surface-elevated)] px-2 py-1 text-secondary">{props.children}</span>
)

export default OpencodeSessionRepairDialog
